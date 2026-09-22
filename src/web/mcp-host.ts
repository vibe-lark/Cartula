// A standards-based local test host, deliberately separate from the product workspace.
//
// Scenario switches (query string) let one page stand in for the hosts Cartula
// has to survive; they only shape what this host declares or answers, never
// what the app is allowed to do:
//   noDims           host that declares no container dimensions at all
//   w / h            fixed container axis (host owns it)
//   maxw / maxh      elastic container axis (view decides within the bound)
//   deaf             host that takes `ui/notifications/size-changed` and does
//                    nothing with it, sizing the card off the document instead
//                    (anthropics/claude-ai-mcp#69). The view has to be the
//                    right height on its own, without the host's cooperation.
//   noMessage        host without the `message` capability
//   message=reject   host that answers ui/message with isError
//   message=timeout  host that never answers ui/message
//   modes=a,b        what the host declares in availableDisplayModes;
//                    `modes=` (empty) declares nothing at all
//   display=deny     host that answers ui/request-display-mode with inline
//   display=host     host that grants fullscreen itself, without the browser
//                    Fullscreen API, and can hand it back from a test hook
//   noFullscreen     iframe without the fullscreen permission
//   noWorkers        blocks workers, exercising the SVG fallback
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';

type Dimensions = { width?: number; height?: number; maxWidth?: number; maxHeight?: number };

function scenarioDimensions(params: URLSearchParams): Dimensions | undefined {
  // An empty object is a real scenario: a host that constrains neither axis.
  if (params.has('noDims')) return {};
  const read = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);
  const dims: Dimensions = {};
  const width = read('w'); const height = read('h');
  const maxWidth = read('maxw'); const maxHeight = read('maxh');
  if (width !== undefined) dims.width = width;
  if (height !== undefined) dims.height = height;
  if (maxWidth !== undefined) dims.maxWidth = maxWidth;
  if (maxHeight !== undefined) dims.maxHeight = maxHeight;
  return Object.keys(dims).length ? dims : undefined;
}

async function run() {
  const status = document.getElementById('status')!;
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  if (!id) { status.textContent = '在 URL 中添加 ?id=<地图ID>，编辑密钥通过 #key=… 传入。'; return; }
  const key = new URLSearchParams(location.hash.slice(1)).get('key');
  const client = new Client({ name: 'Cartula verification host', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', location.origin)));
  const args = { id, ...(key ? { editKey: key } : {}) };
  const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_map', arguments: args }));
  if (result.isError) throw new Error(JSON.stringify(result.content));
  // Which resource to render is *discovered*, the way a real host discovers it:
  // from the result's `_meta`, falling back to the tool definition. Hardcoding
  // `ui://cartula/map.html` here is what let a server publish an App no host
  // could find and still pass every test in this suite.
  const uiMeta = (meta: unknown) => {
    const bag = meta as { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string } | undefined;
    return bag?.ui?.resourceUri ?? bag?.['ui/resourceUri'];
  };
  const declared = (await client.listTools()).tools.find(tool => tool.name === 'get_map');
  const resourceUri = uiMeta(result._meta) ?? uiMeta(declared?._meta);
  if (!resourceUri) throw new Error('宿主找不到要渲染的界面资源：get_map 的结果和定义都没有声明 resourceUri。');
  status.textContent = `渲染 ${resourceUri}`;
  const resource = await client.readResource({ uri: resourceUri });
  const content = resource.contents[0];
  if (!('text' in content)) throw new Error('Expected HTML resource');
  const iframe = document.getElementById('app') as HTMLIFrameElement;
  if (params.has('noFullscreen')) iframe.removeAttribute('allow');
  let scenario = scenarioDimensions(params);
  // A host that owns its own display mode: granting fullscreen is a context
  // change, not a browser API call. Lets a test cover accept → exit without
  // depending on Fullscreen permissions inside a sandboxed iframe.
  const hostControlled = params.get('display') === 'host';
  let simulatedMode: 'inline' | 'fullscreen' = 'inline';
  // Declared sizes are applied to the iframe as well, so what the app measures
  // matches what the host says it granted.
  if (scenario) {
    // An empty scenario means "no containerDimensions in the context at all";
    // the iframe then keeps the page's own height until the view asks for one.
    if (scenario.height) iframe.style.height = `${scenario.height}px`;
    else if (scenario.maxHeight) iframe.style.height = `${scenario.maxHeight}px`;
    if (scenario.width) iframe.style.width = `${scenario.width}px`;
    else if (scenario.maxWidth) iframe.style.maxWidth = `${scenario.maxWidth}px`;
  }
  const sizes: { width?: number; height?: number }[] = [];
  // Reported sizes are surfaced in the page so a browser test can assert both
  // the value and that the negotiation settled instead of oscillating.
  const sizeLog = document.getElementById('size') ?? Object.assign(document.createElement('pre'), { id: 'size' });
  if (!sizeLog.isConnected) { sizeLog.setAttribute('style', 'position:fixed;bottom:4px;right:8px;background:#fff;font-size:11px;z-index:10;margin:0'); document.body.appendChild(sizeLog); }
  const currentMode = (): 'inline' | 'fullscreen' => (hostControlled ? simulatedMode : document.fullscreenElement ? 'fullscreen' : 'inline');
  const hostContext = (displayMode: 'inline' | 'fullscreen' = currentMode()): McpUiHostContext => {
    const rect = iframe.getBoundingClientRect();
    return {
      theme: 'light' as const,
      displayMode,
      // `modes=` narrows what this host says it offers, and `modes=` with no
      // value drops the field entirely — a host that never declares any. The
      // App's own constructor list is what *it* supports and is a different
      // thing; only this one says what the host will grant.
      ...(params.has('modes') && !params.get('modes') ? {} : { availableDisplayModes: (params.get('modes') ?? 'inline,fullscreen').split(',') as ('inline' | 'fullscreen')[] }),
      // Fullscreen means "use the whole surface": the host stops constraining.
      ...(displayMode === 'fullscreen' || (scenario && !Object.keys(scenario).length) ? {} : { containerDimensions: scenario ?? { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) } }),
      locale: 'zh-CN',
      platform: 'web' as const,
    };
  };
  const bridge = new AppBridge(client, { name: 'Cartula verification host', version: '0.1.0' }, { serverTools: {}, updateModelContext: {}, ...(params.has('noOpenLinks') ? {} : { openLinks: {} }), ...(params.has('noMessage') ? {} : { message: { text: {} } }) }, { hostContext: hostContext() });
  const publishContext = () => { bridge.setHostContext(hostContext(currentMode())); };
  bridge.oninitialized = () => { void (async () => { publishContext(); await bridge.sendToolInput({ arguments: args }); await bridge.sendToolResult(result); status.textContent = 'MCP Apps bridge 已连接'; })(); };
  bridge.onupdatemodelcontext = async update => { document.getElementById('context')!.textContent = JSON.stringify(update); return {}; };
  bridge.onmessage = async payload => {
    const mode = params.get('message');
    // A host that never answers is the honest way to produce "结果未知".
    if (mode === 'timeout') return new Promise<never>(() => {});
    document.getElementById('message')!.textContent = JSON.stringify(payload);
    if (mode === 'reject') return { isError: true, content: [{ type: 'text', text: '宿主拒绝了这条消息（测试场景）' }] };
    return {};
  };
  bridge.onsizechange = size => {
    sizes.push(size);
    sizeLog.textContent = JSON.stringify({ last: size, count: sizes.length });
    // A deaf host still receives the notification — it just never acts on it,
    // so the iframe keeps the height the host picked and the view has to be
    // sized correctly without any help.
    if (params.has('deaf')) return;
    // Elastic axes: a spec-compliant host resizes the iframe to what the view
    // asked for, which is exactly the loop the app has to avoid re-triggering.
    if (!scenario?.height && size.height) iframe.style.height = `${size.height}px`;
    if (!scenario?.width && size.width) iframe.style.width = `${size.width}px`;
    if (scenario) publishContext();
  };
  const openedLinks: string[] = [];
  bridge.onopenlink = async ({ url }) => {
    openedLinks.push(url);
    if (params.get('links') === 'reject') return { isError: true };
    if (params.get('links') !== 'record' && /^https?:/.test(url)) window.open(url, '_blank', 'noopener');
    return {};
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    if (params.get('display') === 'deny') return { mode: currentMode() };
    if (hostControlled) {
      simulatedMode = mode === 'fullscreen' ? 'fullscreen' : 'inline';
      iframe.style.height = simulatedMode === 'fullscreen' ? '100vh' : scenario?.height ? `${scenario.height}px` : scenario?.maxHeight ? `${scenario.maxHeight}px` : '';
      publishContext();
      return { mode: simulatedMode };
    }
    if (mode === 'fullscreen') await iframe.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    const actual = currentMode();
    bridge.setHostContext(hostContext(actual));
    return { mode: actual };
  };
  if (!scenario) {
    window.addEventListener('resize', publishContext);
    new ResizeObserver(publishContext).observe(iframe);
  }
  document.addEventListener('fullscreenchange', publishContext);
  // Test hooks: drive context updates from a spec, including partial ones.
  // `sendPartial` bypasses the bridge's own diffing on purpose — that is how a
  // host that only reports the axis that changed behaves.
  (window as unknown as { cartulaHost: unknown }).cartulaHost = {
    sizes,
    openedLinks,
    teardown: () => bridge.teardownResource({}),
    context: () => hostContext(),
    /** What the App called itself in `ui/initialize` — the release it was served with. */
    appVersion: () => bridge.getAppVersion(),
    setDimensions(next: Dimensions) { scenario = next; bridge.setHostContext({ ...hostContext(), containerDimensions: next }); },
    /** The host takes the mode back, the way a real one would on Esc. */
    setDisplayMode(mode: 'inline' | 'fullscreen') { simulatedMode = mode; iframe.style.height = mode === 'fullscreen' ? '100vh' : scenario?.height ? `${scenario.height}px` : scenario?.maxHeight ? `${scenario.maxHeight}px` : ''; publishContext(); },
    sendPartial(patch: Record<string, unknown>) { void bridge.sendHostContextChange(patch as never); },
  };
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = params.has('noWorkers') ? content.text.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="worker-src \'none\'">') : content.text;
  window.addEventListener('beforeunload', () => { void bridge.close(); void client.close(); });
}
void run().catch(error => { document.getElementById('status')!.textContent = error instanceof Error ? error.message : '连接失败'; });
