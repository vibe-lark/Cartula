/**
 * Outcome of handing this round of edits to the host conversation.
 *
 * "Saved to the map", "handed to the conversation" and "the agent is working"
 * are three different facts. A boolean collapsed a refusal, a missing
 * capability and a timeout into the same "not sent", which made the UI claim
 * more (or less) than it knew. The states below are what the view can actually
 * observe:
 *
 *  - `sent`        the host accepted `ui/message`.
 *  - `unsupported` the host never advertised the message capability, or
 *                  answered "method not found". Nothing was delivered.
 *  - `rejected`    the host answered, and the answer was a refusal.
 *  - `unknown`     timeout or transport failure. The message may or may not
 *                  have arrived; it must not be resent automatically.
 *
 * None of these means the agent started replying — only the host decides that.
 */
export type DeliveryStatus = 'sent' | 'unsupported' | 'rejected' | 'unknown';

export interface PlanningDelivery {
  status: DeliveryStatus;
  /** Host-supplied explanation, when there is one. Never invented. */
  detail?: string;
}

/** JSON-RPC error codes used by the MCP SDK (`ErrorCode` in @modelcontextprotocol/sdk). */
const REQUEST_TIMEOUT = -32001;
const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const PARSE_ERROR = -32700;
/**
 * JSON-RPC reserves -32000…-32099 for implementation-defined server errors.
 * Hosts put their own refusals there — "the user declined", "this conversation
 * is read-only" — but the SDK also reports a dropped connection as -32000, and
 * a host's own crash lands there too. The code alone therefore decides nothing:
 * a refusal has to be *stated*, either in a structured field or in words, and
 * anything else in the range stays unknown so the resend protection holds.
 */
const SERVER_ERROR_RANGE = { max: -32000, min: -32099 };
/** Wording a lost connection or a timeout produces, in either SDK or host words. */
const TRANSPORT_FAILURE = /connection\s*(closed|lost|reset|refused|error)|not connected|disconnect|transport|socket|network|econn|abort|timed\s*out|timeout|连接(已)?(关闭|断开|中断|丢失)|已断开|网络|超时/i;
/**
 * Wording that says a host *decided* not to post the message. Several distinct
 * ways of saying it, because no single word covers hosts that answer in their
 * own vocabulary — and none of them is a generic failure.
 */
const STATED_REFUSAL = /reject|refus|declin|denied|deny|not allowed|not permitted|disallow|forbidden|unauthori[sz]ed|no permission|read-?only|cancel|blocked|拒绝|谢绝|不允许|不接受|无权|没有权限|已取消|只读/i;
/** Wording that says the host broke, which decides nothing about delivery. */
const GENERIC_FAILURE = /internal (server )?error|unexpected|unhandled|unknown error|server error|not implemented|panic|crash|out of memory|内部错误|服务(器)?错误|未知错误|异常/i;

/**
 * A refusal the host stated in a field rather than in prose.
 *
 * Structured evidence outranks wording: a marker, a 4xx-style status, or a
 * refusal-shaped code means the host decided, whatever its message says.
 */
function structuredRefusal(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object') return false;
  const fields = data as Record<string, unknown>;
  if (fields.rejected === true || fields.refused === true || fields.declined === true) return true;
  if (typeof fields.status === 'number' && fields.status >= 400 && fields.status < 500) return true;
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  return Boolean(code && STATED_REFUSAL.test(code));
}

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** One readable line, without the wire code the reader cannot act on. */
function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/^MCP error -?\d+:\s*/i, '').trim();
  return text || undefined;
}

/**
 * The host's own words for what happened.
 *
 * A refusal is only worth showing if it says why, and hosts put the reason in
 * either the error message or the `data` an `McpError` carries — so both are
 * read, and the second is appended only when it adds something.
 */
function errorText(error: unknown): string | undefined {
  const message = clean(error instanceof Error ? error.message : error);
  const data = (error as { data?: unknown } | null)?.data;
  const fields = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
  const attached = clean(typeof data === 'string' ? data : [fields?.reason, fields?.message, fields?.error].find(value => typeof value === 'string'));
  const text = attached && attached !== message && !message?.includes(attached)
    ? [message, attached].filter(Boolean).join(' · ')
    : message;
  return text ? text.slice(0, 300) : undefined;
}

/**
 * Classify a thrown `app.sendMessage(...)` failure.
 *
 * The distinction that matters is whether the host *decided* something.
 *
 *  - The codes that mean something everywhere are taken at face value:
 *    `-32601` is "this host has no such method", and a malformed or invalid
 *    request was refused outright — nothing reached the conversation.
 *  - In the implementation-defined range a refusal counts only when the host
 *    said so: a structured marker, or refusal wording in its message. That is
 *    reported as refused, with the host's reason.
 *  - Everything else in that range — an internal error, a bare code, a dropped
 *    connection — decided nothing observable, so it stays unknown. The host may
 *    have taken the message and failed afterwards, and the user confirms before
 *    anything is sent twice.
 *
 * The default is deliberately `unknown`: claiming a refusal that never happened
 * would invite a second copy of the same round into the conversation.
 */
export function classifyMessageError(error: unknown): PlanningDelivery {
  const code = errorCode(error);
  const detail = errorText(error);
  const as = (status: DeliveryStatus): PlanningDelivery => ({ status, ...(detail ? { detail } : {}) });
  if (code === METHOD_NOT_FOUND) return as('unsupported');
  if (code === INVALID_REQUEST || code === INVALID_PARAMS || code === PARSE_ERROR) return as('rejected');
  if (code === REQUEST_TIMEOUT) return as('unknown');
  if (code !== undefined && code <= SERVER_ERROR_RANGE.max && code >= SERVER_ERROR_RANGE.min) {
    if (detail && TRANSPORT_FAILURE.test(detail)) return as('unknown');
    if (structuredRefusal(error)) return as('rejected');
    if (detail && STATED_REFUSAL.test(detail) && !GENERIC_FAILURE.test(detail)) return as('rejected');
    return as('unknown');
  }
  // An internal host error, or a failure with no code at all: it may have been
  // raised before or after the message was posted. Unknown is the honest answer.
  return as('unknown');
}

/** Classify a returned `ui/message` result. `isError` is an explicit refusal. */
export function classifyMessageResult(result: { isError?: boolean; content?: { type: string; text?: string }[] } | undefined): PlanningDelivery {
  if (!result) return { status: 'unknown' };
  if (!result.isError) return { status: 'sent' };
  const detail = result.content?.find(item => item.type === 'text')?.text?.trim();
  return { status: 'rejected', ...(detail ? { detail: detail.slice(0, 300) } : {}) };
}

/**
 * An error the server stated outright, as opposed to one the client inferred
 * from silence. The distinction decides what may be claimed afterwards: a
 * stated refusal wrote nothing, while a lost answer leaves the outcome open.
 */
export function rejection(message: string): Error {
  return Object.assign(new Error(message), { rejected: true });
}

export type SubmitOutcome = 'rejected' | 'unknown';

/** Unknown unless the failure says otherwise — the safer claim. */
export function submitOutcome(error: unknown): SubmitOutcome {
  return (error as { rejected?: unknown } | null)?.rejected === true ? 'rejected' : 'unknown';
}

/**
 * A failed hand-off in the user's language. Version conflicts are the one
 * error the view can explain better than the transport can: nothing was
 * submitted, and the way forward is to look at the newer map first.
 */
export function submitErrorText(message: string): string {
  if (/VERSION_CONFLICT|版本冲突/.test(message)) return '地图已经有更新的版本，这一轮还没有交出去。请先看看最新的地图，再重新提交。';
  if (/UNKNOWN_VERSION/.test(message)) return '这一轮对不上地图的版本，还没有交出去。请重新载入地图后再提交。';
  return message;
}

/**
 * What to say when the submission itself failed.
 *
 * Two different things are at stake: edits already saved on the map are safe,
 * while the intent typed for this round only exists in the copyable message
 * unless the submit wrote it. Whether it did depends on `outcome` — a stated
 * refusal wrote nothing, a lost or unreadable answer decided nothing — so the
 * notice follows that instead of assuming either.
 */
export function fallbackNotice(context: { version: number; hasIntent: boolean; outcome: SubmitOutcome }): string {
  const saved = `之前保存过的修改还在地图上（截至 v${context.version}）。`;
  const round = context.outcome === 'rejected'
    ? (context.hasIntent
      ? '这次填写的意图没有写进地图，但已经放进下面的消息里；重新提交成功后才会保存。'
      : '这一轮还没有交给 Agent。')
    : (context.hasIntent
      ? '这次填写的意图是否已经写进地图还不确定，它已经放进下面的消息里；恢复后重新提交不会重复记录同一次修改。'
      : '这一轮是否已经交出去还不确定。');
  return `${saved}${round}可以先复制下面的消息手动发送，稍后再重试提交。`;
}

export interface DeliveryNotice {
  tone: 'ok' | 'warn' | 'info';
  /** What is certain. */
  text: string;
  /** What the user should do next; empty when nothing is required. */
  hint: string;
  /** Whether offering "send again" makes sense at all. */
  canRetry: boolean;
  /**
   * The message may already be in the conversation, so the user has to
   * confirm they looked before a resend is unlocked. A refusal needs no such
   * check: nothing arrived.
   */
  confirmBeforeRetry: boolean;
}

/**
 * User-facing wording per delivery state. Kept here — not in JSX — so the
 * distinctions are unit-testable and cannot drift between call sites.
 *
 * `saved` is independent: the map is stored server-side before any message is
 * attempted, so a failed hand-off never means lost edits.
 */
export function deliveryNotice(delivery: PlanningDelivery, context: { mode: string; version: number; saved: boolean }): DeliveryNotice {
  const saved = context.saved ? `修改已保存到地图 v${context.version}。` : '';
  switch (delivery.status) {
    case 'sent':
      return { tone: 'ok', text: `${saved}已交给对话。`, hint: '等待对话里继续处理。', canRetry: false, confirmBeforeRetry: false };
    case 'unsupported':
      return {
        tone: 'info',
        text: `${saved}${context.mode === 'mcp' ? '这里不能直接发送到对话。' : '此页面不能直接发送到对话。'}`,
        hint: '请复制下面的消息，粘贴回原来的对话。',
        canRetry: false,
        confirmBeforeRetry: false,
      };
    case 'rejected':
      return {
        tone: 'warn',
        text: `${saved}这条消息被拒绝了${delivery.detail ? `：${delivery.detail}` : '。'}`,
        hint: '消息没有进入对话，可以复制下面的内容手动发送。',
        canRetry: true,
        confirmBeforeRetry: false,
      };
    default:
      return {
        tone: 'warn',
        text: `${saved}这条消息没有得到确认，结果未知。`,
        hint: '请先回对话查看：已经出现同一条消息就不要重复发送，没有出现再复制或重发。',
        canRetry: true,
        confirmBeforeRetry: true,
      };
  }
}
