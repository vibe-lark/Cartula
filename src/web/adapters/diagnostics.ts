/**
 * A read-out of the size negotiation, for looking at a card inside a real host.
 *
 * Everything here answers one question: when this card comes out the wrong
 * height in a host we cannot attach a debugger to, was it the host's numbers,
 * our arithmetic, or the layout? So it shows all three side by side —
 * `containerDimensions` exactly as the host sent it, what that resolved to, and
 * what the document actually measured afterwards.
 *
 * Off unless the deployment turns it on (`CARTULA_DIAGNOSTICS=1`, which the
 * beta ConfigMap sets and nothing else does). It is a diagnostic, not a
 * feature: no product code reads it, and it never appears in a default build.
 */
import { SIZE_DECLARED_EVENT, renderedSize, resolveSizeRequest, type HostSizeContext, type SizeDeclaration } from './host-size.js';
import { DISPLAY_MODE_EVENT, type DisplayModeAttempt } from './types.js';

/** The read-out also needs what the host allows, which is not a layout input. */
type DiagnosticContext = HostSizeContext & { availableDisplayModes?: unknown };

const NOTHING = '—';

function describeDeclaration(declaration: SizeDeclaration | undefined): string {
  if (!declaration) return '未申请（尚未发生）';
  const box = declaration.request ? `${declaration.request.width ?? NOTHING}×${declaration.request.height ?? NOTHING}` : '无内容';
  const status = { sent: '已发送', unchanged: '未变化', skipped: '跳过', failed: '失败' }[declaration.status];
  return `${status} ${box}${declaration.detail ? ` (${declaration.detail})` : ''}`;
}

/**
 * What became of pressing 展开 — both mechanisms, because "nothing happened"
 * has several causes that look identical from the outside: the host never
 * offered fullscreen, the host answered `granted` and then did not switch, or
 * the Fullscreen API is not permitted inside the frame.
 */
function describeDisplayMode(attempt: DisplayModeAttempt | undefined): string {
  if (!attempt) return '未触发（还没点过展开）';
  const outcome = attempt.outcome;
  const host = !outcome ? '没有宿主可申请'
    : outcome.status === 'unsupported' ? '未发送：宿主没有声明 fullscreen'
    : outcome.status === 'granted' ? `已发送，宿主答 granted (${outcome.mode})`
    : outcome.status === 'denied' ? `已发送，宿主改答 ${outcome.mode}`
    : `已发送但报错${outcome.detail ? `：${outcome.detail}` : ''}`;
  const browser = attempt.browserFullscreen === undefined ? '未尝试浏览器全屏'
    : attempt.browserFullscreen ? '浏览器全屏成功' : '浏览器全屏失败';
  return `${host}；${browser}`;
}

/** Whole numbers only; a fractional pixel here is noise, not information. */
const px = (value: number) => String(Math.round(value));

function report(ctx: DiagnosticContext | undefined, declaration: SizeDeclaration | undefined, attempt: DisplayModeAttempt | undefined) {
  const dims = ctx?.containerDimensions;
  const resolved = renderedSize(ctx);
  const body = document.body.getBoundingClientRect();
  const root = document.documentElement;
  const canvas = document.querySelector('.map-canvas');
  return [
    ['地图渲染', `${canvas?.getAttribute('data-mode') ?? NOTHING}${canvas?.getAttribute('data-fallback') ? ` (${canvas.getAttribute('data-fallback')})` : ''}`],
    ['地图 Worker', `classic / ${canvas?.getAttribute('data-worker') ?? NOTHING}`],
    ['containerDimensions', dims === undefined ? '未发送 (undefined)' : JSON.stringify(dims)],
    ['displayMode', ctx?.displayMode === undefined ? '未发送 (undefined)' : String(ctx.displayMode)],
    ['availableDisplayModes', ctx?.availableDisplayModes === undefined ? '未发送 (undefined)' : JSON.stringify(ctx.availableDisplayModes)],
    ['全屏请求', describeDisplayMode(attempt)],
    ['申请', describeDeclaration(declaration)],
    ['本应申请', JSON.stringify(resolveSizeRequest(ctx))],
    ['算出的渲染尺寸', resolved ? `${resolved.width}×${resolved.height}` : '全屏（不设限）'],
    ['body 实测', `${px(body.width)}×${px(body.height)}`],
    ['documentElement 实测', `${px(root.getBoundingClientRect().width)}×${px(root.getBoundingClientRect().height)}`],
    ['documentElement client/scroll 高', `${root.clientHeight}/${root.scrollHeight}`],
    ['--app-height', getComputedStyle(root).getPropertyValue('--app-height').trim() || '未设置'],
  ] as const;
}

/**
 * Show the read-out, and mirror it onto `data-cartula-size` so it can be pulled
 * out of a DOM dump as well as read off the card.
 *
 * Re-rendered on host context changes, on declarations, and on body resizes,
 * because the interesting case is precisely the one where those disagree.
 */
export function mountSizeDiagnostics() {
  if (typeof document === 'undefined') return () => {};
  const panel = document.createElement('div');
  panel.className = 'size-diagnostics';
  panel.setAttribute('role', 'status');
  let latest: SizeDeclaration | undefined;
  // The adapter publishes the merged context with every change; the browser
  // fullscreen listener publishes without one, and must not erase it.
  let context: DiagnosticContext | undefined;
  let attempt: DisplayModeAttempt | undefined;
  const draw = () => {
    const rows = report(context, latest, attempt);
    panel.textContent = '';
    // Rebuilt on every draw alongside the rows: draw() clears the panel first.
    const title = document.createElement('span');
    title.className = 'size-diagnostics-title';
    title.textContent = '⚠ 地图与尺寸诊断 · CARTULA_DIAGNOSTICS 测试构建 ⚠';
    panel.append(title);
    for (const [label, value] of rows) {
      const line = document.createElement('div');
      line.append(Object.assign(document.createElement('b'), { textContent: `${label} ` }), document.createTextNode(value));
      panel.append(line);
    }
    document.documentElement.dataset.cartulaSize = rows.map(([label, value]) => `${label}=${value}`).join('; ');
  };
  const onDeclared = (event: Event) => { latest = (event as CustomEvent<SizeDeclaration>).detail; draw(); };
  const onDisplayMode = (event: Event) => { attempt = (event as CustomEvent<DisplayModeAttempt>).detail; draw(); };
  const onContext = (event: Event) => {
    const detail = (event as CustomEvent<DiagnosticContext | undefined>).detail;
    if (detail) context = detail;
    draw();
  };
  window.addEventListener('cartula:host-context-changed', onContext);
  window.addEventListener(SIZE_DECLARED_EVENT, onDeclared);
  window.addEventListener(DISPLAY_MODE_EVENT, onDisplayMode);
  // The layout settles after the context does, so measurements taken only on
  // context changes would report the box from before the relayout.
  const observer = new ResizeObserver(draw);
  observer.observe(document.body);
  const mapObserver = new MutationObserver(draw);
  const appRoot = document.getElementById('root');
  if (appRoot) mapObserver.observe(appRoot, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-worker', 'data-mode', 'data-fallback'] });
  document.body.append(panel);
  draw();
  return () => {
    window.removeEventListener('cartula:host-context-changed', onContext);
    window.removeEventListener(SIZE_DECLARED_EVENT, onDeclared);
    window.removeEventListener(DISPLAY_MODE_EVENT, onDisplayMode);
    observer.disconnect();
    mapObserver.disconnect();
    panel.remove();
    delete document.documentElement.dataset.cartulaSize;
  };
}
