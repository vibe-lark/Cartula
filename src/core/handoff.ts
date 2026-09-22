import type { MapSnapshot, SemanticEvent } from './types.js';

/**
 * How the map's own address is named wherever it is handed to somebody.
 *
 * `map.url` is the private page: it carries no credential and opens only for
 * whoever already holds one for this space. Calling it a read-only link — which
 * this message used to do — invited exactly the wrong move, forwarding an
 * address that either fails for the recipient or, worse, travels together with
 * the key that would make it work. A real read-only share is a different thing
 * with a different address: `share_map` mints a `previewUrl` carrying its own
 * token, and only that may be called 分享.
 */
export const MAP_URL_LABEL = '地图地址（需要当前空间权限）';
export const MAP_URL_NOTE = '这个地址不含密钥，用你当前空间的凭据打开；要给别人只读分享请调用 share_map 生成分享链接。';

/**
 * The share credential this hand-off should carry, when the person handing
 * off is a share recipient rather than the owner.
 *
 * `previewToken` is the one credential that is safe to put in a message meant
 * for somebody else's Agent: it opens exactly this map, and nothing else the
 * sender holds. `canWrite` mirrors the grant the token was minted with — never
 * guessed from the token's shape — and decides whether the hint below offers
 * `patch_map` or only `copy_map`.
 */
export interface PlanningMessageOptions {
  previewToken?: string;
  canWrite?: boolean;
}

export function planningMessage(map: MapSnapshot, since = 0, options?: PlanningMessageOptions) {
  const events = map.events.filter(event => event.actor === 'user' && event.version > since);
  const changes = events.flatMap(event => event.changes);
  const firstVersion = events[0]?.version;
  const cursor = firstVersion ? firstVersion - 1 : map.version;
  const lines = changes.slice(0, 60).map(change => `- ${change}`);
  const intents = (map.intents ?? []).filter(intent => intent.status !== 'resolved').slice(0, 12);
  const intentLines = intents.map(intent => {
    const where = intent.scope === 'point' ? `地点 ${intent.pointId}` : intent.scope === 'layer' ? `图层 ${intent.layerId}` : '整张地图';
    return `- [${intent.priority ?? 'prefer'}] ${where}：${intent.text}`;
  });
  // Empty when there is no token, so every branch below reduces to today's
  // wording — the owner's message is byte-for-byte what it always was.
  const token = options?.previewToken;
  // `MAP_URL_NOTE` tells the reader to open the address with "your own
  // space's credentials" — correct for the owner, but exactly the wrong first
  // instruction for a share recipient, who has no such credential and must
  // not go looking for one. Only this branch changes; the owner's pair is
  // untouched.
  const addressBlock = map.url
    ? token
      ? `地图地址：${map.url}\n这个地址需要凭据；请用下面的 previewToken 打开，不要用你自己的空间密钥。\n`
      : `${MAP_URL_LABEL}：${map.url}\n${MAP_URL_NOTE}\n`
    : '';
  const credentialBlock = token
    ? `分享凭据 previewToken: ${token}（说明：这是这张地图的分享凭据，只对这张图有效，请在调用 Cartula 工具时作为 previewToken 参数传入）\n`
    : '';
  const tokenArg = token ? `, previewToken="${token}"` : '';
  const more = changes.length > 60 ? '，有更多修改需读取' : '';
  const hint = !token
    ? `请调用 get_map(id="${map.id}"${tokenArg}, since=${cursor}, view="affected") 核对最新摘要和语义事件${more}，保留固定地点和用户备注，只用 patch_map 更新受影响的部分，并在 reason 中说明为什么这样改路线（界面会展示给用户）。不要重新提交旧的整张地图。`
    : options?.canWrite
      ? `请调用 get_map(id="${map.id}"${tokenArg}, since=${cursor}, view="affected") 核对最新摘要和语义事件${more}，保留固定地点和用户备注，只用 patch_map(id="${map.id}"${tokenArg}, …) 更新受影响的部分，并在 reason 中说明为什么这样改路线（界面会展示给用户）。不要重新提交旧的整张地图。`
      : `请调用 get_map(id="${map.id}"${tokenArg}, since=${cursor}, view="affected") 核对最新摘要和语义事件${more}。这个分享链接是只读的，不能用它修改这张地图；需要编辑时请调用 copy_map(id="${map.id}"${tokenArg}) 复制一份自己可编辑的地图。`;
  return `请按我在 Cartula 中的修改继续规划。\n地图：${map.title}\nid: ${map.id}\n当前版本：${map.version}\n${addressBlock}${credentialBlock}\n本轮修改与意图：\n${lines.length ? lines.join('\n').slice(0, 10000) : '请先查看当前地图，并结合我们之前的讨论继续规划。'}${intentLines.length ? `\n结构化意图：\n${intentLines.join('\n')}` : ''}\n\n${hint}`;
}

/** UI copy for an agent version: prefer the authored reason, else the semantic changes. */
export function agentAdjustmentText(event: Pick<SemanticEvent, 'version' | 'changes' | 'reason'>): string {
  const reason = event.reason?.trim();
  if (reason) return `v${event.version} · ${reason}`;
  const changes = event.changes.filter(Boolean);
  if (!changes.length) return `v${event.version} · Agent 更新了地图`;
  const shown = changes.slice(0, 8).join('；');
  return `v${event.version} · ${shown}${changes.length > 8 ? '…' : ''}`;
}
