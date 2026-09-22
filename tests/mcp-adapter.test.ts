/**
 * MCP App view logic that has to be right before any host is involved:
 * container-size negotiation, hand-off outcomes and out-of-order results.
 *
 * These are the pure halves of `src/web/adapters/*`; the wiring against a real
 * `AppBridge` host is covered by `tests/e2e/embedding.spec.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COMPACT_HEIGHT,
  PREFERRED_HEIGHT,
  PREFERRED_WIDTH,
  declaredSize,
  hostLayout,
  renderedSize,
  resolveSizeRequest,
  sameSizeRequest,
} from '../src/web/adapters/host-size.js';
import { McpAdapter, type HostApp } from '../src/web/adapters/mcp.js';
import { classifyMessageError, classifyMessageResult, deliveryNotice, fallbackNotice, rejection, submitErrorText, submitOutcome } from '../src/web/adapters/delivery.js';
import {
  CONFLICT_RETRY_MESSAGE,
  CONFLICT_TARGET_GONE_MESSAGE,
  ConflictError,
  IdempotentRequest,
  beginSubmit,
  isStaleSnapshot,
  isVersionConflict,
  latestOf,
  reportReplaceConflict,
  retryEditConflictOnce,
  widensWindow,
} from '../src/web/adapters/state.js';
import { HandoffCursor, handoffFloor, type CursorStorage } from '../src/web/handoff-cursor.js';
import { roundSummary } from '../src/web/handoff.js';
import type { MapSnapshot } from '../src/core/types.js';

test('unconstrained hosts get the desktop target; a fixed axis the view fills is left alone', () => {
  assert.equal(PREFERRED_HEIGHT, 720);
  assert.equal(PREFERRED_WIDTH, 1280);
  // A map is unreadable in a small card, so an axis the host left open is
  // asked for at the desktop target instead of being silently accepted.
  assert.deepEqual(resolveSizeRequest(undefined), { width: 1280, height: 720 });
  assert.deepEqual(resolveSizeRequest({ containerDimensions: {} }), { width: 1280, height: 720 });
  // A fixed axis the view fills has nothing to report: the host would only be
  // told the number it just sent. The open width axis is still worth asking.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { height: 500 } }), { width: 1280 });
  assert.equal(resolveSizeRequest({ containerDimensions: { width: 900, height: 500 } }), null);
  // Fixed width still leaves height to negotiate.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { width: 900 } }), { height: 720 });
});

test('a fixed axis is an upper bound, not an instruction to fill it', () => {
  // The regression this exists for. A host that fixes the height at 1600px has
  // decided how much room *it* has; a card filling all of it is one the reader
  // scrolls several screens past. The view renders 720 and says so — that
  // report is the only way the host learns it can take the other 880 back.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { height: 1600 } }), { width: 1280, height: 720 });
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { width: 1400, height: 1600 } }), { width: 1280, height: 720 });
  // Below the target it is a limit like any other, and filling it stays silent.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { height: 500, width: 1600 } }), { width: 1280 });
  // Fixed and elastic on the same axis: the smallest of everything declared.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { height: 1600, maxHeight: 400 } }), { width: 1280, height: 400 });
  // What the layout will render, whether or not it was worth reporting.
  assert.deepEqual(renderedSize({ containerDimensions: { height: 1600 } }), { width: 1280, height: 720 });
  assert.deepEqual(renderedSize({ containerDimensions: { height: 500 } }), { width: 1280, height: 500 });
  assert.deepEqual(renderedSize({ containerDimensions: { maxHeight: 240 } }), { width: 1280, height: 240 });
  assert.equal(renderedSize({ displayMode: 'fullscreen' }), null, 'fullscreen has no box of ours');
});

/**
 * The shape the bug was actually reported against, in the numbers a real host
 * actually sent: `{maxHeight: 5000, width: 766}`, read off the diagnostics
 * panel in Claude Desktop 1.49585.0 on 2026-09-09. Not a constructed case.
 *
 * Every earlier round guessed at this and guessed wrong — a large *fixed*
 * height, a host ignoring size-changed — and the matrix grew cases for each
 * guess while never covering "elastic, with a bound far above the target".
 * 5000px is roughly six screens, which is exactly what the card looked like
 * while `axisRequest` took the whole elastic bound (73df4c5) instead of
 * `min(target, bound)`.
 */
test('the Claude Desktop shape: an elastic bound of 5000px yields one screen', () => {
  const claude = { displayMode: 'inline', containerDimensions: { maxHeight: 5000, width: 766 } };
  // The width axis is fixed at the card's own width and is filled exactly, so
  // there is nothing to say about it; the height is ours to choose, and 5000px
  // of room does not make a 5000px card the right answer.
  assert.deepEqual(resolveSizeRequest(claude), { height: 720 });
  assert.deepEqual(renderedSize(claude), { width: 766, height: 720 });
  // `--app-height` resolves to min(720, 720, 5000) for the same context — the
  // layout half is asserted against a live browser in tests/e2e/embedding.spec.ts.
  assert.equal(hostLayout(claude).variables['--host-max-height'], '5000px');
  assert.equal(hostLayout(claude).variables['--host-width'], '766px');
  assert.equal(hostLayout(claude).compact, false, '766px wide is not the compact layout');
});

test('an elastic axis is filled to the host bound, with no floor and the target as ceiling', () => {
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxHeight: 600 } }), { width: 1280, height: 600 });
  // An elastic bound is permission, not an instruction. A host with 1600px to
  // spare is describing its own room; a card that takes all of it is one the
  // reader has to scroll past, so the request stops at the target.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxHeight: 1600 } }), { width: 1280, height: 720 });
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxWidth: 2560, maxHeight: 900 } }), { width: 1280, height: 720 });
  // The old formula asked for 320 here and overshot the host's own limit.
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxHeight: 240 } }), { width: 1280, height: 240 });
  assert.ok(COMPACT_HEIGHT > 240, 'compact is a layout threshold, never a request floor');
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxWidth: 420, maxHeight: 600 } }), { width: 420, height: 600 });
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { width: 800, maxHeight: 600 } }), { height: 600 });
});

test('the height ceiling is one number: the stylesheet and the request agree on it', () => {
  // The request cannot read CSS and the cap cannot import TypeScript, so the
  // ceiling exists twice by necessity. Drift between them is the failure this
  // catches: a stylesheet capping at 720 while the request asks for 900 would
  // hand every host a card with dead space under the map.
  const css = readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
  assert.equal(css.match(/--app-max-height:\s*(\d+)px/)?.[1], String(PREFERRED_HEIGHT));
  // Both host variables have to sit *inside* the min(), each falling back to
  // the ceiling. Reading either as `var(--host-…, <ceiling>)` instead would let
  // a declared 1600 straight through — a `var()` fallback only applies when the
  // variable is missing, which is exactly the case that was never the problem.
  assert.match(css, /--app-height:min\(var\(--app-max-height\),var\(--host-height,var\(--app-max-height\)\),var\(--host-max-height,var\(--app-max-height\)\)\)/);
  // The ceiling reaches an embedded card whatever display mode the host names,
  // including none: keying it to a mode the host has to send correctly is how
  // it would go missing in the host that needed it.
  assert.match(css, /html\[data-embedded\]:not\(\[data-display-mode="fullscreen"\]\):not\(\[data-browser-fullscreen\]\)\{--app-height:/);
});

test('declared dimensions are taken literally: 0 is a bound, not "unlimited"', () => {
  assert.equal(resolveSizeRequest({ displayMode: 'fullscreen', containerDimensions: { maxHeight: 600 } }), null);
  // The spec types these as plain numbers with no minimum, so 0 is declared.
  assert.equal(declaredSize(0), 0);
  assert.equal(declaredSize(600.4), 600.4, 'exact, so a bound is never rounded up');
  assert.equal(declaredSize(-10), undefined);
  assert.equal(declaredSize(Number.NaN), undefined);
  assert.equal(declaredSize(Number.POSITIVE_INFINITY), undefined);
  assert.equal(declaredSize('600' as unknown), undefined);
  // height: 0 is a fixed axis the host owns — asking for 720 would override it.
  assert.equal(resolveSizeRequest({ containerDimensions: { height: 0, width: 0 } }), null);
  // maxHeight: 0 leaves nothing to ask for; the host already knows its bound.
  assert.equal(resolveSizeRequest({ containerDimensions: { maxHeight: 0, maxWidth: 0 } }), null);
  assert.equal(hostLayout({ containerDimensions: { maxHeight: 0 } }).variables['--host-max-height'], '0px');
});

test('a fractional bound rounds down, never up past the host limit', () => {
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxHeight: 239.6 } }), { width: 1280, height: 239 });
  assert.deepEqual(resolveSizeRequest({ containerDimensions: { maxWidth: 519.8, maxHeight: 700.9 } }), { width: 519, height: 700 });
  // The layout keeps the exact value so the box cannot exceed it either.
  assert.equal(hostLayout({ containerDimensions: { maxHeight: 239.6 } }).variables['--host-max-height'], '239.6px');
  assert.equal(hostLayout({ containerDimensions: { height: 500.5 } }).variables['--host-height'], '500.5px');
});

test('the same request is never sent twice — that is how a resize loop starts', () => {
  const first = resolveSizeRequest({ containerDimensions: { maxHeight: 600 } });
  const echoed = resolveSizeRequest({ containerDimensions: { maxHeight: 600 } });
  assert.ok(sameSizeRequest(first, echoed));
  assert.ok(!sameSizeRequest(first, { height: 601 }));
  assert.ok(sameSizeRequest(null, null));
  assert.ok(!sameSizeRequest(null, { height: 720 }));
  // A host that grants the request by pinning both axes ends the exchange.
  assert.equal(resolveSizeRequest({ containerDimensions: { height: 600, width: 900 } }), null);
});

test('root layout follows the host: fixed axes pin, elastic axes cap, fullscreen clears', () => {
  const fixed = hostLayout({ containerDimensions: { width: 900, height: 500 } });
  assert.equal(fixed.variables['--host-height'], '500px');
  assert.equal(fixed.variables['--host-width'], '900px');
  assert.equal(fixed.variables['--host-max-height'], null);
  assert.equal(fixed.compact, false);

  const elastic = hostLayout({ containerDimensions: { maxWidth: 420, maxHeight: 600 } });
  assert.equal(elastic.variables['--host-max-height'], '600px');
  assert.equal(elastic.variables['--host-max-width'], '420px');
  assert.equal(elastic.variables['--host-height'], null, 'an elastic axis must not be pinned');
  assert.equal(elastic.compact, true, '420px wide is below the compact width');

  const full = hostLayout({ displayMode: 'fullscreen', containerDimensions: { maxHeight: 600 } });
  assert.deepEqual(Object.values(full.variables), [null, null, null, null]);

  assert.equal(hostLayout({ containerDimensions: { maxHeight: 240 } }).compact, true);
  assert.equal(hostLayout({ containerDimensions: { height: 300, width: 1200 } }).compact, true);
  assert.equal(hostLayout({ containerDimensions: { height: 720, width: 1200 } }).compact, false);
  assert.equal(hostLayout(undefined).compact, false);
});

test('a partial host-context update is resolved against the merged context', () => {
  // The SDK merges `host-context-changed` shallowly into the context it hands
  // back, so a theme-only update must not drop the negotiated dimensions.
  const initial = { theme: 'light', displayMode: 'inline', containerDimensions: { width: 900, maxHeight: 600 } };
  const merged = { ...initial, ...{ theme: 'dark' } };
  assert.deepEqual(resolveSizeRequest(merged), { height: 600 });
  assert.equal(hostLayout(merged).variables['--host-max-height'], '600px');
  // A dimensions-only update replaces that key wholesale — the new axes win.
  const resized = { ...merged, ...{ containerDimensions: { width: 900, height: 380 } } };
  assert.equal(resolveSizeRequest(resized), null);
  assert.equal(hostLayout(resized).variables['--host-height'], '380px');
  assert.equal(hostLayout(resized).variables['--host-max-height'], null);
  // Switching to fullscreen and back restores the inline constraints.
  assert.equal(resolveSizeRequest({ ...resized, displayMode: 'fullscreen' }), null);
  assert.equal(hostLayout({ ...resized, displayMode: 'inline' }).variables['--host-height'], '380px');
});

test('message delivery keeps refusal, absence and an unknown result apart', () => {
  assert.deepEqual(classifyMessageResult({}), { status: 'sent' });
  assert.deepEqual(classifyMessageResult({ isError: true, content: [{ type: 'text', text: '宿主拒绝' }] }), { status: 'rejected', detail: '宿主拒绝' });
  assert.deepEqual(classifyMessageResult(undefined), { status: 'unknown' });
  // -32001 RequestTimeout: the host may still have taken the message.
  assert.equal(classifyMessageError(Object.assign(new Error('Request timed out'), { code: -32001 })).status, 'unknown');
  assert.equal(classifyMessageError(Object.assign(new Error('no such method'), { code: -32601 })).status, 'unsupported');
  assert.equal(classifyMessageError(Object.assign(new Error('bad params'), { code: -32602 })).status, 'rejected');
  assert.equal(classifyMessageError(Object.assign(new Error('malformed'), { code: -32700 })).status, 'rejected');
  assert.equal(classifyMessageError(new Error('boom')).status, 'unknown');
});

test('a host that states a refusal under -32000 is a refusal; a bare or broken one is not', () => {
  // JSON-RPC reserves -32000…-32099 for the host's own errors, and three very
  // different things arrive there: a stated refusal, a host that broke, and a
  // dropped connection. Only the first one decided anything.
  const refused = classifyMessageError(Object.assign(new Error('MCP error -32000: 用户拒绝了这条消息'), { code: -32000 }));
  assert.deepEqual(refused, { status: 'rejected', detail: '用户拒绝了这条消息' }, 'the wire code is not the reason');
  assert.equal(classifyMessageError(Object.assign(new Error('QA host rejected message'), { code: -32000 })).status, 'rejected');
  assert.equal(classifyMessageError(Object.assign(new Error('permission denied for this conversation'), { code: -32003 })).status, 'rejected');
  assert.equal(classifyMessageError(Object.assign(new Error('this conversation is read-only'), { code: -32000 })).status, 'rejected');
  // A reason the host attached as data is shown too, and only once.
  const withData = classifyMessageError(Object.assign(new Error('MCP error -32000: message rejected'), { code: -32000, data: { reason: '这个对话不接受来自应用的消息' } }));
  assert.equal(withData.status, 'rejected');
  assert.equal(withData.detail, 'message rejected · 这个对话不接受来自应用的消息');
  // Structured evidence outranks prose: a marker, a 4xx-shaped status, or a
  // refusal-shaped code is a decision even when the message reads like a crash.
  for (const data of [{ rejected: true }, { status: 403 }, { code: 'USER_DECLINED' }]) {
    assert.equal(classifyMessageError(Object.assign(new Error('internal error'), { code: -32000, data })).status, 'rejected', JSON.stringify(data));
  }

  // No evidence of a decision: the host may have taken the message and failed
  // afterwards, so the resend protection has to stay on.
  for (const message of ['Internal server error', 'unexpected failure while handling ui/message', '内部错误', '']) {
    assert.equal(classifyMessageError(Object.assign(new Error(message), { code: -32000 })).status, 'unknown', message || '(no message)');
  }
  assert.equal(classifyMessageError({ code: -32050 }).status, 'unknown', 'a bare reserved code states nothing');
  assert.equal(classifyMessageError(Object.assign(new Error('internal error'), { code: -32000, data: { status: 503 } })).status, 'unknown');

  // The SDK reports a dropped connection under the same code. Nothing was
  // decided there either.
  for (const message of ['MCP error -32000: Connection closed', 'connection closed', 'transport disconnected', '连接已断开', 'request timed out', 'connection refused']) {
    assert.equal(classifyMessageError(Object.assign(new Error(message), { code: -32000 })).status, 'unknown', message);
  }
  // An explicitly structured refusal in the returned result is still a refusal.
  assert.equal(classifyMessageResult({ isError: true, content: [{ type: 'text', text: '宿主拒绝' }] }).status, 'rejected');

  const context = { mode: 'mcp', version: 3, saved: true };
  assert.equal(deliveryNotice({ status: 'unknown' }, context).confirmBeforeRetry, true);
  assert.equal(deliveryNotice({ status: 'rejected', detail: '用户拒绝了这条消息' }, context).confirmBeforeRetry, false);
  assert.ok(deliveryNotice({ status: 'rejected', detail: '用户拒绝了这条消息' }, context).text.includes('用户拒绝了这条消息'));
});

test('a same-version result still counts when it carries more of the history', () => {
  // A write answers against its own baseVersion, so its event list covers that
  // write alone; the poll that follows reads everything at the same version.
  const narrow = { id: 'map-a', version: 5, sinceVersion: 4, events: [{}] };
  const full = { id: 'map-a', version: 5, sinceVersion: 0, events: [{}, {}, {}] };
  assert.equal(widensWindow(narrow, full), true);
  assert.equal(widensWindow(full, narrow), false, 'a narrower window is not news');
  assert.equal(widensWindow(full, full), false);
  // Different map, or a different version: other rules decide those.
  assert.equal(widensWindow(narrow, { ...full, id: 'map-b' }), false);
  assert.equal(widensWindow(narrow, { ...full, version: 6 }), false);
  assert.equal(widensWindow(undefined, full), false);
  // Without sinceVersion, more events is still more history.
  assert.equal(widensWindow({ id: 'map-a', version: 5, events: [{}] }, { id: 'map-a', version: 5, events: [{}, {}] }), true);
});

test('each delivery state says only what is known, and no state claims the agent started', () => {
  const context = { mode: 'mcp', version: 9, saved: true };
  const sent = deliveryNotice({ status: 'sent' }, context);
  assert.equal(sent.tone, 'ok');
  assert.ok(sent.text.includes('v9'), sent.text);
  assert.ok(sent.text.includes('已交给对话'));
  assert.equal(sent.canRetry, false);

  const unknown = deliveryNotice({ status: 'unknown' }, context);
  assert.equal(unknown.tone, 'warn');
  assert.ok(unknown.text.includes('结果未知'));
  assert.ok(unknown.hint.includes('不要重复发送'));
  assert.equal(unknown.canRetry, true, 'a resend is offered, but only as an explicit choice');
  assert.equal(unknown.confirmBeforeRetry, true, 'the user has to confirm they checked the conversation first');

  const rejected = deliveryNotice({ status: 'rejected', detail: '用户取消' }, context);
  assert.ok(rejected.text.includes('用户取消'));
  assert.ok(rejected.hint.includes('没有进入对话'));
  assert.equal(rejected.confirmBeforeRetry, false, 'nothing arrived, so nothing has to be checked');

  const unsupported = deliveryNotice({ status: 'unsupported' }, context);
  assert.ok(unsupported.text.includes('不能直接发送到对话'));
  assert.ok(unsupported.hint.includes('复制'));
  assert.equal(unsupported.canRetry, false);

  for (const status of ['sent', 'unsupported', 'rejected', 'unknown'] as const) {
    const notice = deliveryNotice({ status }, context);
    const copy = `${notice.text}${notice.hint}`;
    assert.ok(!copy.includes('正在处理'), status);
    // Product wording only: no protocol or implementation vocabulary.
    for (const word of ['宿主', 'ui/message', '界面', 'MCP']) assert.ok(!copy.includes(word), `${status}: ${word}`);
    assert.ok(notice.text.includes('修改已保存到地图 v9'), status);
  }
  // Nothing was written: the notice must not claim a save either.
  assert.ok(!deliveryNotice({ status: 'unknown' }, { ...context, saved: false }).text.includes('已保存'));
});

test('staleness is per map: older versions of the open map only', () => {
  // How the adapter uses this is covered end to end in adapter-races.test.ts.
  const current = { id: 'a', version: 9 };
  assert.equal(isStaleSnapshot(current, { id: 'a', version: 8 }), true);
  assert.equal(isStaleSnapshot(current, { id: 'a', version: 9 }), false);
  assert.equal(isStaleSnapshot(current, { id: 'a', version: 10 }), false);
  // A result for another map is not "stale" — it is a different map, and the
  // adapter decides separately whether that switch is legitimate.
  assert.equal(isStaleSnapshot(current, { id: 'b', version: 1 }), false);
  assert.equal(isStaleSnapshot(undefined, { id: 'a', version: 1 }), false);
});

test('one attempt keeps one id; a new submission is a new write, even with the same words', () => {
  let n = 0;
  const mint = () => `id-${++n}`;
  const round = { mapId: 'map-a', baseVersion: 2, currentVersion: 4, userMessage: '每天不超过三小时' };
  const first = beginSubmit(undefined, round, mint);
  // Polling moved the map on, but this is still the same unresolved attempt.
  const retry = beginSubmit(first, { ...round, currentVersion: 9 }, mint);
  assert.equal(retry, first);
  assert.equal(retry.requestId, 'id-1');
  assert.equal(retry.currentVersion, 4, 'the attempt keeps the version it was written against');

  // Resolved (or rejected) → the record is dropped, and the next submission of
  // the very same sentence must not be de-duplicated against the last one.
  const again = beginSubmit(undefined, round, mint);
  assert.notEqual(again.requestId, first.requestId);
  // A different map, cursor or message is a different attempt too.
  for (const changed of [{ mapId: 'map-b' }, { baseVersion: 5 }, { userMessage: '换个说法' }]) {
    assert.notEqual(beginSubmit(first, { ...round, ...changed }, mint).requestId, first.requestId, JSON.stringify(changed));
  }
});

test('a failed submission claims neither that the intent was saved nor that it was not', () => {
  // Stated refusal: nothing was written, and it is safe to say so.
  const refused = fallbackNotice({ version: 3, hasIntent: true, outcome: 'rejected' });
  assert.ok(refused.includes('v3'), refused);
  assert.ok(refused.includes('没有写进地图'), refused);
  assert.ok(refused.includes('放进下面的消息里'), refused);
  assert.ok(refused.includes('之前保存过的修改还在地图上'));
  // Lost answer: the write may well have landed, so nothing is asserted.
  const unknown = fallbackNotice({ version: 3, hasIntent: true, outcome: 'unknown' });
  assert.ok(unknown.includes('还不确定'), unknown);
  assert.ok(!/意图没有写进地图|尚未保存/.test(unknown), unknown);
  const nothingTyped = fallbackNotice({ version: 3, hasIntent: false, outcome: 'rejected' });
  assert.ok(!nothingTyped.includes('意图'), nothingTyped);
  assert.ok(nothingTyped.includes('还没有交给 Agent'));
  assert.ok(fallbackNotice({ version: 3, hasIntent: false, outcome: 'unknown' }).includes('还不确定'));

  // The classification itself: only an error the server stated is "rejected".
  assert.equal(submitOutcome(rejection('VERSION_CONFLICT · 请重新读取')), 'rejected');
  assert.equal(submitOutcome(new Error('连接中断，这次操作是否已经保存还不确定。')), 'unknown');
  assert.equal(submitOutcome(undefined), 'unknown');
});

test('rejected submissions are explained, not echoed as protocol codes', () => {
  const conflict = submitErrorText('VERSION_CONFLICT · 请重新读取地图');
  assert.ok(!conflict.includes('VERSION_CONFLICT'));
  assert.ok(conflict.includes('还没有交出去'), conflict);
  const unknown = submitErrorText('UNKNOWN_VERSION · currentVersion 超前');
  assert.ok(!unknown.includes('UNKNOWN_VERSION'));
  assert.ok(unknown.includes('重新载入'), unknown);
  assert.equal(submitErrorText('连接中断，这次操作是否已经保存还不确定。'), '连接中断，这次操作是否已经保存还不确定。');
});

test('identical retries reuse one requestId; a different payload gets its own', () => {
  let n = 0;
  const requests = new IdempotentRequest(() => `id-${++n}`);
  const first = requests.begin('[{"op":"delete"}]', 4);
  const retry = requests.begin('[{"op":"delete"}]', 7);
  assert.equal(retry.requestId, first.requestId, 'the same edit must not create a second event');
  assert.equal(retry.baseVersion, 4, 'the retry keeps the base version the server deduplicates against');
  assert.equal(requests.pending, true);

  const other = requests.begin('[{"op":"insert"}]', 7);
  assert.notEqual(other.requestId, first.requestId);
  requests.clear();
  assert.equal(requests.pending, false);
  assert.notEqual(requests.begin('[{"op":"insert"}]', 8).requestId, other.requestId, 'a new round after success is a new request');
});

/** An error shaped like the one `request()`/`raise()` throw for a stated HTTP rejection. */
function statusError(status: number, message = `status ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

test('the freshest of two same-map snapshots wins a write; a different map is not this helper\'s call', () => {
  const ahead = { id: 'map-a', version: 5 };
  const behind = { id: 'map-a', version: 3 };
  // The ordinary case: `openMap.current` leads the render.
  assert.equal(latestOf(ahead, behind), ahead);
  // The race this exists for: a stale pushed update left `openMap.current`
  // behind the render instead — the higher version still wins either way.
  assert.equal(latestOf(behind, ahead), ahead);
  // Equal versions: nothing to gain from discarding the render's own copy.
  const same = { id: 'map-a', version: 4 };
  assert.equal(latestOf({ id: 'map-a', version: 4 }, same), same);
  // A different map id, or no open map yet, leaves the render's snapshot alone.
  assert.equal(latestOf({ id: 'map-b', version: 99 }, behind), behind);
  assert.equal(latestOf(undefined, behind), behind);
});

test('isVersionConflict recognises exactly the 409 the server states for a stale baseVersion', () => {
  assert.equal(isVersionConflict(statusError(409)), true);
  assert.equal(isVersionConflict(statusError(404)), false);
  assert.equal(isVersionConflict(statusError(400)), false);
  assert.equal(isVersionConflict(new Error('no status field at all')), false);
  assert.equal(isVersionConflict(undefined), false);
});

test('a conflicting edit is replayed once against the refreshed version, with a new request id', async () => {
  const attempts: { baseVersion: number; requestId: string }[] = [];
  let refreshCalls = 0;
  const send = async (attempt: { baseVersion: number; requestId: string }) => {
    attempts.push(attempt);
    if (attempts.length === 1) throw statusError(409, 'VERSION_CONFLICT · 请先读取 since=4 的摘要，再只提交受影响操作');
    return { version: attempt.baseVersion + 1 };
  };
  const result = await retryEditConflictOnce(
    { baseVersion: 4, requestId: 'req-1' },
    send,
    async () => { refreshCalls += 1; return 9; },
    () => 'req-2',
  );
  assert.deepEqual(result, { version: 10 }, 'the retry\'s own result is returned, as if the first attempt had produced it');
  assert.equal(attempts.length, 2, 'exactly two edit requests were sent');
  assert.equal(attempts[0].requestId, 'req-1');
  assert.equal(attempts[0].baseVersion, 4);
  assert.equal(attempts[1].baseVersion, 9, 'the retry uses the version the refresh reported');
  assert.notEqual(attempts[1].requestId, attempts[0].requestId, '409 means nothing was written; reusing the id would dedupe against no one');
  assert.equal(refreshCalls, 1);
});

test('two conflicts in a row give up in plain language, never the raw VERSION_CONFLICT text', async () => {
  const send = async () => { throw statusError(409, 'VERSION_CONFLICT · 请先读取 since=4 的摘要，再只提交受影响操作'); };
  await assert.rejects(
    retryEditConflictOnce({ baseVersion: 4, requestId: 'req-1' }, send, async () => 9, () => 'req-2'),
    (error: unknown) => {
      if (!(error instanceof ConflictError)) throw new Error(`expected a ConflictError, got ${error}`);
      assert.equal(error.message, CONFLICT_RETRY_MESSAGE);
      assert.ok(!error.message.includes('VERSION_CONFLICT'), error.message);
      assert.equal(error.code, 'conflict');
      assert.ok(error.cause instanceof Error, 'the technical detail survives on cause, not in message');
      return true;
    },
  );
});

test('a replay refused because its target is gone gets its own plain-language message', async () => {
  let call = 0;
  const send = async () => {
    call += 1;
    if (call === 1) throw statusError(409, 'VERSION_CONFLICT');
    // What `points.reorder`/`reorder` throw once the fresh map no longer has
    // what the operations named — a 400 or a 404, both a stated rejection.
    throw statusError(400, '图层「lesser-khingan」中没有 id 为「harbin」的点');
  };
  await assert.rejects(
    retryEditConflictOnce({ baseVersion: 4, requestId: 'req-1' }, send, async () => 9, () => 'req-2'),
    (error: unknown) => {
      if (!(error instanceof ConflictError)) throw new Error(`expected a ConflictError, got ${error}`);
      assert.equal(error.message, CONFLICT_TARGET_GONE_MESSAGE);
      assert.equal(error.code, 'conflict');
      return true;
    },
  );
});

test('a non-conflict failure is never retried, and the refresh is never even called', async () => {
  let calls = 0;
  const send = async () => { calls += 1; throw statusError(500, '服务暂时无法完成请求'); };
  const refresh = async (): Promise<number> => { throw new Error('must not be called for a non-409'); };
  await assert.rejects(retryEditConflictOnce({ baseVersion: 4, requestId: 'req-1' }, send, refresh, () => 'req-2'), /服务暂时无法完成请求/);
  assert.equal(calls, 1);
});

test('a refresh that fails surfaces on its own; the helper does not relabel it as a conflict', async () => {
  const send = async () => { throw statusError(409, 'VERSION_CONFLICT'); };
  const refresh = async (): Promise<number> => { throw new Error('连接中断，这次操作是否已经保存还不确定。'); };
  await assert.rejects(retryEditConflictOnce({ baseVersion: 4, requestId: 'req-1' }, send, refresh, () => 'req-2'), /连接中断/);
});

test('a whole-map replace conflict refreshes and clears the pending id, but is never replayed', async () => {
  let refreshCalls = 0;
  let cleared = false;
  const original = statusError(409, 'VERSION_CONFLICT');
  await assert.rejects(
    reportReplaceConflict(original, async () => { refreshCalls += 1; return 9; }, () => { cleared = true; }),
    (error: unknown) => {
      if (!(error instanceof ConflictError)) throw new Error(`expected a ConflictError, got ${error}`);
      assert.equal(error.message, CONFLICT_RETRY_MESSAGE);
      assert.equal(error.cause, original);
      return true;
    },
  );
  assert.equal(refreshCalls, 1, 'the map is refreshed so the next attempt starts from the real version');
  assert.equal(cleared, true, 'a genuinely new attempt must mint its own id rather than reuse this one\'s');
});

test('a non-conflict replace failure passes straight through: nothing is refreshed or cleared', async () => {
  let refreshCalls = 0;
  let cleared = false;
  const original = statusError(400, '地图数据格式不正确');
  await assert.rejects(
    reportReplaceConflict(original, async () => { refreshCalls += 1; return 9; }, () => { cleared = true; }),
    (error: unknown) => error === original,
  );
  assert.equal(refreshCalls, 0);
  assert.equal(cleared, false);
});

/** A storage that behaves like the browser's, including its failure modes. */
function fakeStorage(initial: Record<string, string> = {}): CursorStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

type Event = { version: number; actor: 'user' | 'agent'; changes: string[]; operations?: { op: string }[] };
function mapWith(events: Event[], version: number, boundaries: { handoffVersion?: number; agentVersion?: number } = {}): MapSnapshot {
  return {
    id: 'map-a', title: '兴安岭', version, parent: version - 1, changed: false, changes: [], ...boundaries,
    events: events.map(event => ({ ...event, at: new Date(2026, 8, 8).toISOString(), operations: (event.operations ?? []) as MapSnapshot['events'][number]['operations'] })),
    updatedAt: new Date(2026, 8, 8).toISOString(), url: 'https://cartula.test/map/map-a', layers: [],
  };
}
const commit = [{ op: 'draft.commit' }];

test('the hand-off boundary survives a reload instead of resetting to 0', () => {
  const store = fakeStorage();
  const before = new HandoffCursor([store]);
  before.mark('map-a', 4);
  // A reload of the frame: new instance, no memory, same origin storage.
  const after = new HandoffCursor([store]);
  assert.equal(after.read('map-a', 9), 4, 'a reload must not re-offer rounds that were already handed over');
  assert.equal(after.read('map-b', 9), 0, 'other maps are unaffected');

  // Only what is above the boundary is this round; a reset to 0 would hand the
  // whole change log over a second time.
  const map = mapWith([
    { version: 3, actor: 'user', changes: ['上一轮：删掉尼斯'] },
    { version: 4, actor: 'user', changes: ['上一轮：提交草稿'] },
    { version: 5, actor: 'agent', changes: ['Agent 更新了地图方案'] },
    { version: 6, actor: 'user', changes: ['这一轮：加入五大连池'] },
  ], 6);
  assert.deepEqual(roundSummary(map, after.read('map-a', map.version)), ['这一轮：加入五大连池']);
  assert.equal(roundSummary(map, 0).length, 3, 'a cursor back at 0 would repeat two handed-over rounds');
});

test('the boundary only moves forward, and never past what the map can support', () => {
  const store = fakeStorage();
  const cursor = new HandoffCursor([store]);
  cursor.mark('map-a', 7);
  cursor.mark('map-a', 5);
  assert.equal(cursor.read('map-a', 9), 7, 'a late confirmation from an earlier round must not pull it back');
  cursor.mark('map-a', 9);
  assert.equal(cursor.read('map-a', 9), 9);

  // A record that cannot describe the map in front of it — a restored copy, an
  // id reused — is discarded rather than believed: re-offering changes is
  // recoverable, silently skipping them is not.
  const impossible = new HandoffCursor([fakeStorage({ 'cartula:submitted:map-a': '12' })]);
  assert.equal(impossible.read('map-a', 4), 0);
  assert.equal(impossible.read('map-a', 4), 0, 'and it is forgotten, not re-read every render');
  for (const junk of ['', 'abc', '-3', '1e400', 'null']) {
    assert.equal(new HandoffCursor([fakeStorage({ 'cartula:submitted:map-a': junk })]).read('map-a', 9), 0, junk);
  }
});

test('a hand-off cursor degrades to memory when storage refuses, and never throws', () => {
  const denied: CursorStorage = {
    getItem: () => { throw new Error('storage disabled'); },
    setItem: () => { throw new Error('storage disabled'); },
    removeItem: () => { throw new Error('storage disabled'); },
  };
  const cursor = new HandoffCursor([denied]);
  cursor.mark('map-a', 6);
  assert.equal(cursor.read('map-a', 9), 6, 'this session still knows what it handed over');
  assert.equal(new HandoffCursor([]).read('map-a', 9), 0, 'and a frame with no storage at all starts clean');

  // Two stores, one of them written by an older build: the higher value wins,
  // because the cursor is monotonic.
  const cross = new HandoffCursor([fakeStorage({ 'cartula:submitted:map-a': '2' }), fakeStorage({ 'cartula:submitted:map-a': '5' })]);
  assert.equal(cross.read('map-a', 9), 5);
  cross.mark('map-a', 6);
  assert.equal(new HandoffCursor([]).read('map-a', 9), 0);
});

test('a frame with no storage recovers the boundary the server recorded', () => {
  // An App in a sandboxed frame has an opaque origin: every storage API throws,
  // so a reload has only what the map carries. `handoffVersion` is the server's
  // record of a delivery this view confirmed through `record_handoff`.
  const blind = new HandoffCursor([]);
  const recorded = mapWith([
    { version: 2, actor: 'user', changes: ['删掉尼斯'] },
    { version: 3, actor: 'user', changes: ['提交草稿：交给 Agent 继续规划'], operations: commit },
    { version: 4, actor: 'agent', changes: ['Agent 改走瑞士内陆'] },
    { version: 5, actor: 'user', changes: ['加入五大连池'] },
  ], 5, { handoffVersion: 3 });
  assert.equal(handoffFloor(recorded), 3);
  assert.equal(blind.read('map-a', 5, handoffFloor(recorded)), 3);
  assert.deepEqual(roundSummary(recorded, blind.read('map-a', 5, handoffFloor(recorded))), ['加入五大连池']);

  assert.equal(handoffFloor(mapWith([], 3)), 0, 'a map with no record has no boundary');
  assert.equal(handoffFloor(undefined), 0);
  for (const junk of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(handoffFloor(mapWith([], 5, { handoffVersion: junk })), 0, String(junk));
  }
});

test('an undelivered submission is never inferred as handed over, whatever the Agent did next', () => {
  // The trap this replaces: a `draft.commit` followed by an Agent version looks
  // like a completed round, but the message may have been refused or timed out
  // while the Agent wrote for its own reasons. Believing that pair would drop
  // the user's changes with nothing in the UI to show what was skipped.
  const undelivered = mapWith([
    { version: 2, actor: 'user', changes: ['删掉尼斯'] },
    { version: 3, actor: 'user', changes: ['提交草稿：交给 Agent 继续规划'], operations: commit },
    { version: 4, actor: 'agent', changes: ['Agent 更新了地图方案'] },
  ], 4);
  assert.equal(handoffFloor(undelivered), 0, 'no server record means nothing was confirmed');
  const cursor = new HandoffCursor([]);
  assert.equal(cursor.read('map-a', 4, handoffFloor(undelivered)), 0);
  // The round stays on offer, in full.
  assert.deepEqual(roundSummary(undelivered, cursor.read('map-a', 4, handoffFloor(undelivered))), ['删掉尼斯', '提交草稿：交给 Agent 继续规划']);
  // The Agent's own write cursor is not a hand-off boundary either.
  assert.equal(handoffFloor(mapWith([{ version: 4, actor: 'agent', changes: ['Agent 更新了地图方案'] }], 4, { agentVersion: 4 })), 0);
});

test('what this side knows outranks the server record, and never the reverse', () => {
  const store = fakeStorage();
  const cursor = new HandoffCursor([store]);
  const map = mapWith([
    { version: 2, actor: 'user', changes: ['提交草稿：交给 Agent 继续规划'], operations: commit },
    { version: 3, actor: 'agent', changes: ['Agent 更新了地图方案'] },
    { version: 4, actor: 'user', changes: ['又删掉一个地点'] },
    { version: 5, actor: 'user', changes: ['提交草稿：交给 Agent 继续规划'], operations: commit },
  ], 5, { handoffVersion: 2, agentVersion: 3 });
  // The second round was delivered and the acknowledgement has not landed yet:
  // the server still says v2, this side knows v5.
  cursor.mark('map-a', 5);
  assert.equal(cursor.read('map-a', 5, handoffFloor(map)), 5);
  assert.deepEqual(roundSummary(map, cursor.read('map-a', 5, handoffFloor(map))), []);
  // A frame that knows nothing falls back to the record, not to 0 and not to
  // the Agent version.
  assert.equal(new HandoffCursor([]).read('map-a', 5, handoffFloor(map)), 2);
  assert.deepEqual(roundSummary(map, 2), ['Agent 更新了地图方案'].filter(() => false).concat(['又删掉一个地点', '提交草稿：交给 Agent 继续规划']));
});

/**
 * A host that authenticates with an account API Key hands this frame no
 * credential at all: the key sits in an HTTP header the App never sees, and the
 * tool calls it makes ride the same authenticated session. So "may I write" is
 * the server's `access.editable`, not "am I holding a key" — the two used to be
 * conflated, and the card rendered editable and then refused every edit as
 * read-only, which was true of the key drawer and not of the map.
 */
type Call = { name: string; arguments: Record<string, unknown> };
/** A result as the server builds it: the map under `_meta`, with its context. */
function toolResult(context: Record<string, unknown>, version: number) {
  const snapshot = { id: 'map-1', title: '账号授权', updatedAt: '2026-09-10T00:00:00.000Z', url: 'https://example.test/map/map-1', layers: [], events: [], changes: [] };
  return {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { id: snapshot.id, version },
    _meta: { cartula: { map: { ...snapshot, version }, ...context } },
  };
}

function fakeHost(context: Record<string, unknown>, reply?: (call: Call) => unknown) {
  const calls: Call[] = [];
  const app = {
    connect: async () => ({}),
    getHostContext: () => ({ containerDimensions: { width: 900, height: 600 } }),
    getHostCapabilities: () => ({}),
    sendSizeChanged: async () => {},
    updateModelContext: async () => {},
    close: async () => {},
    callServerTool: async (call: Call) => {
      calls.push(call);
      return reply?.(call) ?? toolResult(context, 4);
    },
  } as unknown as HostApp;
  return { app, calls, first: toolResult(context, 3) };
}

async function openCard(context: Record<string, unknown>, reply?: (call: Call) => unknown) {
  const { app, calls, first } = fakeHost(context, reply);
  const adapter = new McpAdapter(app);
  const ready = adapter.initialize(() => {});
  app.ontoolresult!(first as never);
  const snapshot = await ready;
  return { adapter, calls, snapshot };
}

const OWNER = { kind: 'owner', editable: true, canShare: true, canClaim: false, claimed: true };
const PREVIEW = { kind: 'preview', editable: false, canShare: false, canClaim: false, claimed: false };

test('an account-authorised card may write without holding a credential', async () => {
  const { adapter, calls, snapshot } = await openCard({ access: OWNER });
  try {
    assert.equal(adapter.editable, true);
    await adapter.edit(snapshot, [{ op: 'annotate', layerId: 'r', pointId: 'a', text: '账号身份也能改' }]);
    const edit = calls.find(call => call.name === 'edit_map')!;
    assert.ok(edit, 'the call is made instead of being refused locally');
    // No credential argument: the HTTP session is the authority, and inventing
    // one here would be inventing a key this frame was never given.
    assert.equal(edit.arguments.spaceKey, undefined);
    assert.equal(edit.arguments.editKey, undefined);
    // The boundary is recorded too. Gated on a held key it returned silently,
    // so the same round came back after every reload.
    await adapter.recordHandoff('map-1', 4);
    assert.ok(calls.some(call => call.name === 'record_handoff'), 'the hand-off boundary reaches the server');
  } finally { adapter.dispose(); }
});

test('a read-only card still refuses, and says the true reason', async () => {
  const { adapter, calls, snapshot } = await openCard({ access: PREVIEW, previewToken: 'cpt_x' });
  try {
    assert.equal(adapter.editable, false);
    await assert.rejects(adapter.edit(snapshot, [{ op: 'annotate', layerId: 'r', pointId: 'a', text: '越权' }]), /只读/);
    await adapter.recordHandoff('map-1', 4);
    assert.deepEqual(calls, [], 'nothing reaches the server on a read-only view');
  } finally { adapter.dispose(); }
});

test('unlocking with a share token does not pretend the card became editable', async () => {
  // `get_map_state` needs read access, and a share token has that — so the call
  // succeeds and "it worked" is not the same as "it unlocked". Pasting a bare
  // cpt_ token into the unlock box used to land on `this.editable = true`
  // regardless of what the server had just said the credential was.
  const { adapter } = await openCard({ access: PREVIEW, previewToken: 'cpt_x' });
  try {
    await assert.rejects(adapter.unlock('cpt_x'), /只能查看/);
    assert.equal(adapter.editable, false, 'and the view stays read-only');
  } finally { adapter.dispose(); }
});

test('a refused unlock leaves the card exactly as it found it', async () => {
  // The card is writeable through an account API Key — no credential of its
  // own — and someone pastes a share token into the unlock box. Refusing is
  // half the job: `accept` applies the answer's metadata before anything looks
  // at it, so the refusal used to also demote a working card to read-only until
  // the next poll happened to restore it.
  const { adapter } = await openCard({ access: OWNER }, () => toolResult({ access: PREVIEW, previewToken: 'cpt_x' }, 4));
  try {
    await assert.rejects(adapter.unlock('cpt_x'), /只能查看/);
    assert.equal(adapter.editable, true, 'the card it was before the paste');
  } finally { adapter.dispose(); }
});

test('a stale answer cannot smuggle a share token in as an owner key', async () => {
  // `accept` skips `applyMeta` for a snapshot older than the one on screen, so
  // asking the adapter's state afterwards asks about the *previous* call. The
  // verdict has to come from this answer, which is the only one that describes
  // the credential just pasted in.
  const { adapter } = await openCard({ access: OWNER }, () => toolResult({ access: PREVIEW, previewToken: 'cpt_x' }, 1));
  try {
    await assert.rejects(adapter.unlock('cpt_x'), /只能查看/);
    assert.equal(adapter.editable, true);
  } finally { adapter.dispose(); }
});
