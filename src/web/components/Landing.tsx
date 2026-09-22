import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight, ArrowUpRight, BookOpen, Braces, Check, Copy, Download, ExternalLink, GitBranch, Layers,
  LayoutTemplate, Lock, Menu, MessageSquare, MousePointer2, Package, Palette, Route, Share2, Sparkles, Terminal, Waypoints, X,
} from 'lucide-react';
import { LICENSE_NAME, RELEASE_VERSION, REPOSITORY_URL } from '../../core/release.js';
import { copyText } from './clipboard.js';
import { DemoCaption, EditDemo, HeroCanvas, LayersDemo, ShareDemo, usePrefersReducedMotion } from './LandingDemos.js';
import '../landing.css';

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function Logo() {
  return <span className="lp-logo">
    <svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#1456f0" />
      <path d="m8 22 5-13 5 13 6-12M10 17h11" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="10" r="2.4" fill="#9fc0ff" />
    </svg>
    <span>Cartula</span>
  </span>;
}

/** The GitHub mark (Octicons, MIT). lucide dropped brand icons, so it is inlined. */
function GitHubMark({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>;
}

function CodeBlock({ lang, code, label }: { lang: string; code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    // The code is on screen; a host that refuses both copy routes still leaves it selectable.
    if (await copyText(code) === 'unavailable') return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return <div className="lp-code">
    <div className="lp-code-bar">
      <span className="lp-code-lang">{label ?? lang}</span>
      <button type="button" className="lp-code-copy" onClick={copy} aria-label={copied ? '已复制' : '复制代码'}>
        {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? '已复制' : '复制'}</span>
      </button>
    </div>
    <pre tabIndex={0}><code>{code}</code></pre>
  </div>;
}

function SectionHead({ eyebrow, title, sub, center }: { eyebrow: string; title: ReactNode; sub?: ReactNode; center?: boolean }) {
  return <div className={`lp-section-head${center ? ' lp-section-head-center' : ''}`}>
    <p className="lp-eyebrow">{eyebrow}</p>
    <h2>{title}</h2>
    {sub && <p className="lp-section-sub">{sub}</p>}
  </div>;
}

/* ------------------------------------------------------------------ */
/* Content                                                             */
/* ------------------------------------------------------------------ */

const LOOP_STEPS = [
  { n: '01', icon: Sparkles, title: 'Agent 画上', body: '一次 create_map，路线、地点和图层落到图上。道路由 Cartula 按真实路网解算，不是把停靠点连成直线。' },
  { n: '02', icon: MousePointer2, title: '人在图上改', body: '拖动停靠点、调整顺序、加备注、切换图层。改的是图本身，不用再把坐标和想法打成一段话。' },
  { n: '03', icon: MessageSquare, title: '交回对话', body: '本轮修改汇成一段消息，由宿主直接发送或复制贴回。Agent 用 get_map 读增量，接着画。' },
];

const DEMOS = [
  { id: 'layers', icon: Layers, title: '图层切分', desc: '每个 Agent 一个图层，方案并排比较。', caption: '多个 Agent 写同一张图：各自用 layer.add 新增自己的图层，写入带 baseVersion 和 requestId，方案并排比较，谁也不会覆盖谁。点图层旁的眼睛可以单独显示或隐藏。' },
  { id: 'edit', icon: Route, title: '路径编辑', desc: '拖一个点，道路重新解算，改动待交接。', caption: '在图上把住宿点从都灵拖到安纳西，Cartula 按道路重新解算这一段，里程和车程随之更新。改动进入本轮待交接列表，交给 Agent 后它读取增量、接着规划。' },
  { id: 'share', icon: Share2, title: '分享交接', desc: '只读或可编辑，对方的 Agent 直接读图。', caption: '分享链接只授权这一张图，只读还是可编辑由你决定。把「分享给 Agent」这段文字贴到对方的对话里，对方的 Agent 凭 previewToken 就能读图；可编辑分享也不能删除或再分享。' },
] as const;

const FEATURES = [
  { icon: Layers, title: '多 Agent 分图层', body: '同一张图上，每个 Agent 写自己的图层。路线、候选地点、备选方案各归其位，比较而不覆盖。' },
  { icon: Waypoints, title: '道路自动解算', body: '只给停靠点，Cartula 按 OSRM 解算真实道路。里程与车程有据可查，拿不到道路时明确标为直线示意。' },
  { icon: Palette, title: '跨天配色', body: '方案分色系，方案内相邻日期深浅明显不同，最多 12 个色阶。哪一天走哪一段，一眼分清。' },
  { icon: GitBranch, title: '增量读取与冲突恢复', body: 'since 读增量，baseVersion 加 requestId 写入。网络未知时重试不重复，版本冲突时不覆盖别人的修改。' },
  { icon: Lock, title: '凭据与权限', body: '空间密钥、账号 API Key、单图 previewToken 三种凭据各管一层。分享默认只读，可编辑也不能删除或再分享。' },
  { icon: LayoutTemplate, title: '嵌进宿主的画布', body: 'MCP Apps 卡片直接出现在 Claude Desktop、Codex 等宿主的对话里。独立网页、离线导出同样可用。' },
];

const TOOLS = ['create_space', 'list_maps', 'create_map', 'get_map', 'patch_map', 'submit_changes', 'share_map', 'copy_map', 'delete_map', 'subscribe_map', 'get_guide'];

type ConnectTab = 'mcp' | 'plugin' | 'skill' | 'rest';
const CONNECT_TABS: Array<{ id: ConnectTab; icon: typeof Braces; label: string; hint: string }> = [
  { id: 'mcp', icon: Braces, label: 'MCP', hint: '对话宿主' },
  { id: 'plugin', icon: Package, label: 'Agent Plugin', hint: 'Skill + MCP 一起装' },
  { id: 'skill', icon: BookOpen, label: 'Agent Skill', hint: '只装指南' },
  { id: 'rest', icon: Terminal, label: 'REST API', hint: '脚本与服务' },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function Landing() {
  const origin = typeof location === 'undefined' || !location.origin ? 'https://cartula.solutionsuite.cn' : location.origin;
  const reduced = usePrefersReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const [demo, setDemo] = useState(0);
  const [autoDemo, setAutoDemo] = useState(true);
  const [tab, setTab] = useState<ConnectTab>('mcp');

  // The showcase walks through its three demos on its own until the reader
  // picks one; a picked demo stays. Reduced motion means no walking at all.
  useEffect(() => {
    if (!autoDemo || reduced) return;
    const timer = setTimeout(() => setDemo(i => (i + 1) % DEMOS.length), 9500);
    return () => clearTimeout(timer);
  }, [autoDemo, demo, reduced]);
  const pickDemo = (index: number) => { setAutoDemo(false); setDemo(index); };

  const mcpJson = JSON.stringify({ mcpServers: { cartula: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer <API_KEY>' } } } }, null, 2);
  const mcpCli = `claude mcp add --transport http cartula ${origin}/mcp \\\n  --header "Authorization: Bearer <API_KEY>"`;
  const pluginTree = `cartula/\n├── plugin.json              # 名称、版本、${LICENSE_NAME} 许可\n├── mcp.json                 # streamable-http → ${origin}/mcp\n├── skills/cartula/SKILL.md  # 与 /llms-full.txt 同一份指南\n├── LICENSE\n└── README.md`;
  const pluginMcp = JSON.stringify({ mcpServers: { cartula: { type: 'streamable-http', url: `${origin}/mcp` } } }, null, 2);
  const skillCall = `// 只连了 MCP 也能读指南：按节取，不占上下文\nget_guide({ "section": "routing" })\n// section：all · essentials · quickstart · collaboration\n//          routing · days · editing · errors · delivery\n\n// 支持 Resources 的宿主直接读\ncartula://skills/cartula/SKILL.md`;
  const curl = `# 申请空间密钥，之后的地图都用它\nKEY=$(curl -s -X POST ${origin}/api/spaces | jq -r .spaceKey)\n\n# 写入一张两日自驾：只给停靠点，道路由 Cartula 解算\ncurl -s -X PUT ${origin}/m/milan-lyon \\\n  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\\n  -d '{"title":"米兰—里昂两日自驾","layers":[{"id":"plan-a","name":"方案 A · 自驾","kind":"route",\n       "points":[{"id":"milan","name":"米兰","at":[9.19,45.46],"day":1},\n                 {"id":"turin","name":"都灵 · 住宿","at":[7.6869,45.0703],"day":2},\n                 {"id":"lyon","name":"里昂","at":[4.8357,45.764],"day":2}]}]}'\n\n# 用户在图上改完后，只读这轮的变化\ncurl -s "${origin}/m/milan-lyon?since=1&view=affected" -H "Authorization: Bearer $KEY"`;
  const selfHost = `git clone ${REPOSITORY_URL}.git && cd Cartula\nnpm ci && npm run build\nPUBLIC_URL=https://maps.example.com BASEMAP_STYLE=liberty npm start\n# 或：cp .env.example .env && docker compose up -d`;

  const navLinks = [['#showcase', '示例'], ['#features', '能力'], ['#connect', '接入'], ['#open-source', '开源']] as const;

  return <div className="lp">
    {/* 导航 */}
    <header className="lp-nav">
      <div className="lp-wrap lp-nav-inner">
        <a className="lp-nav-brand" href="/" aria-label="Cartula 首页"><Logo /></a>
        <nav className="lp-nav-links" aria-label="页面导航">
          {navLinks.map(([href, label]) => <a key={href} href={href}>{label}</a>)}
          <a href="/llms.txt">llms.txt</a>
        </nav>
        <div className="lp-nav-actions">
          <a className="lp-btn lp-btn-ghost" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"><GitHubMark />GitHub</a>
          <a className="lp-btn lp-btn-primary" href="/app">打开画布</a>
          <button type="button" className="lp-nav-toggle" aria-expanded={menuOpen} aria-label={menuOpen ? '收起菜单' : '展开菜单'} onClick={() => setMenuOpen(v => !v)}>
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </div>
      {menuOpen && <nav className="lp-nav-drawer" aria-label="页面导航">
        {navLinks.map(([href, label]) => <a key={href} href={href} onClick={() => setMenuOpen(false)}>{label}</a>)}
        <a href="/llms.txt">llms.txt</a>
        <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"><GitHubMark />GitHub</a>
        <a href="/app" className="lp-nav-drawer-cta">打开画布<ArrowRight size={15} /></a>
      </nav>}
    </header>

    <main>
      {/* 首屏 */}
      <section className="lp-hero">
        <div className="lp-wrap lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-badge"><span className="lp-badge-dot" />{LICENSE_NAME} 开源 · MCP Apps · Agent Plugin</span>
            <h1>给你的 Agent，<br />加上空间表达能力。</h1>
            <p className="lp-hero-sub">
              Cartula 是人和 Agent 共用的地图画布。Agent 在对话里画出路线、地点和图层；你在图上拖点、改线、分享；改动再作为一段消息回到对话，Agent 接着画。
            </p>
            <div className="lp-hero-actions">
              <a className="lp-btn lp-btn-primary lp-btn-lg" href="/app">打开演示画布<ArrowRight size={16} /></a>
              <a className="lp-btn lp-btn-secondary lp-btn-lg" href="#connect">接入你的 Agent</a>
            </div>
            <ul className="lp-hero-meta">
              <li><Check size={14} />无需注册</li>
              <li><Check size={14} />地图默认私有</li>
              <li><Check size={14} />可自托管</li>
            </ul>
          </div>
          <HeroCanvas />
        </div>
      </section>

      {/* 接入面一览 */}
      <section className="lp-strip" aria-label="接入方式一览">
        <div className="lp-wrap lp-strip-inner">
          <span className="lp-strip-label">同一个服务，不同入口</span>
          <ul>
            <li><Braces size={15} />MCP Apps 卡片</li>
            <li><Package size={15} />Agent Plugin</li>
            <li><BookOpen size={15} />Agent Skill</li>
            <li><Terminal size={15} />REST · OpenAPI</li>
            <li><LayoutTemplate size={15} />独立网页</li>
          </ul>
        </div>
      </section>

      {/* 回路 */}
      <section id="loop" className="lp-section lp-section-alt">
        <div className="lp-wrap">
          <SectionHead eyebrow="工作回路" title="画出来，改一改，交回去。" sub="Agent 负责画，人负责改，改动回到对话里。没有第二套工作台，也不用来回描述坐标。" />
          <ol className="lp-steps">
            {LOOP_STEPS.map(step => <li key={step.n} className="lp-step">
              <div className="lp-step-top"><span className="lp-step-icon"><step.icon size={18} /></span><span className="lp-step-num">{step.n}</span></div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>)}
          </ol>
        </div>
      </section>

      {/* 示例 */}
      <section id="showcase" className="lp-section">
        <div className="lp-wrap">
          <SectionHead eyebrow="交互示意" title="三件事，在图上是怎么发生的。" sub="下面的画面是示意，不是截图；但图层、拖点重算和分享权限的行为，和产品里一样。" />
          <div className="lp-showcase">
            <div className="lp-demo-tabs" role="tablist" aria-label="交互示意" aria-orientation="vertical">
              {DEMOS.map((item, index) => <button key={item.id} type="button" role="tab" id={`lp-tab-${item.id}`} aria-selected={demo === index} aria-controls="lp-demo-stage"
                className={`lp-demo-tab${demo === index ? ' lp-demo-tab-on' : ''}`} onClick={() => pickDemo(index)}>
                <span className="lp-demo-tab-icon"><item.icon size={18} /></span>
                <span className="lp-demo-tab-text"><strong>{item.title}</strong><small>{item.desc}</small></span>
                {demo === index && autoDemo && !reduced && <span className="lp-demo-progress" aria-hidden="true" />}
              </button>)}
            </div>
            <div className="lp-demo-panel" id="lp-demo-stage" role="tabpanel" aria-labelledby={`lp-tab-${DEMOS[demo].id}`}>
              {demo === 0 && <LayersDemo key="layers" active />}
              {demo === 1 && <EditDemo key="edit" active />}
              {demo === 2 && <ShareDemo key="share" active origin={origin} />}
              <DemoCaption>{DEMOS[demo].caption}</DemoCaption>
            </div>
          </div>
        </div>
      </section>

      {/* 能力 */}
      <section id="features" className="lp-section lp-section-alt">
        <div className="lp-wrap">
          <SectionHead eyebrow="能力" title="为多 Agent 协作和真实道路而设计。" sub="每一条都对应工具里的一个约定，写在 Skill 里，Agent 读得到。" />
          <ul className="lp-features">
            {FEATURES.map(feature => <li key={feature.title} className="lp-feature">
              <span className="lp-feature-icon"><feature.icon size={18} /></span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </li>)}
          </ul>
        </div>
      </section>

      {/* 接入 */}
      <section id="connect" className="lp-section">
        <div className="lp-wrap">
          <SectionHead eyebrow="接入" title="四种方式，接的是同一个服务。" sub={<>对话宿主走 MCP 或直接装插件，脚本走 REST。下面的地址已经是这个部署的：<code>{origin}</code></>} />
          <div className="lp-connect">
            <div className="lp-connect-tabs" role="tablist" aria-label="接入方式">
              {CONNECT_TABS.map(item => <button key={item.id} type="button" role="tab" id={`lp-connect-${item.id}`} aria-selected={tab === item.id} aria-controls="lp-connect-panel"
                className={`lp-connect-tab${tab === item.id ? ' lp-connect-tab-on' : ''}`} onClick={() => setTab(item.id)}>
                <item.icon size={16} /><span>{item.label}</span><small>{item.hint}</small>
              </button>)}
            </div>
            <div className="lp-connect-panel" id="lp-connect-panel" role="tabpanel" aria-labelledby={`lp-connect-${tab}`}>
              {tab === 'mcp' && <div className="lp-connect-grid">
                <div className="lp-connect-copy">
                  <h3>Streamable HTTP MCP</h3>
                  <p>无状态端点 <code>/mcp</code>。支持 MCP Apps 的宿主（Claude Desktop、Codex 等）把地图卡片直接放进对话；只把工具交给模型的宿主同样能用。</p>
                  <ol className="lp-howto">
                    <li>在宿主的 MCP 设置里新增服务器，地址填 <code>{origin}/mcp</code>；<code>type</code> 写法因客户端而异（<code>http</code> / <code>streamable-http</code>）。</li>
                    <li>可选：<code>Authorization</code> 填账号 API Key（登录后在账号面板创建，前缀 <code>cak_</code>）或空间密钥。不填也能创建自己的空间和地图。</li>
                    <li>让 Agent 调用 <code>create_map</code>。宿主支持 MCP Apps 时，地图卡片直接出现在这条对话里。</li>
                  </ol>
                  <div className="lp-tools" aria-label="模型可用的工具">{TOOLS.map(tool => <code key={tool}>{tool}</code>)}</div>
                </div>
                <div className="lp-connect-code">
                  <CodeBlock lang="json" label="mcp.json · 通用写法" code={mcpJson} />
                  <CodeBlock lang="bash" label="Claude Code" code={mcpCli} />
                </div>
              </div>}
              {tab === 'plugin' && <div className="lp-connect-grid">
                <div className="lp-connect-copy">
                  <h3>Agent Plugin：Skill 与 MCP 一起装</h3>
                  <p>遵循 Agent Plugins 1.0.0 的目录包：根部 <code>plugin.json</code>，Skill 在 <code>skills/cartula/</code>，MCP 连接写在 <code>mcp.json</code>。宿主装一次，同时得到本地指南和连接配置。</p>
                  <ol className="lp-howto">
                    <li>下载 <code>/plugins/cartula.zip</code>；能直接导入 ZIP 的宿主到此为止。</li>
                    <li>否则解压，把含 <code>plugin.json</code> 的 <code>cartula/</code> 目录交给宿主的插件安装入口。</li>
                    <li>凭据仍在宿主的 MCP 凭据管理里配置；插件包不含任何密钥。</li>
                  </ol>
                  <div className="lp-actions">
                    <a className="lp-btn lp-btn-primary" href="/plugins/cartula.zip" download><Download size={15} />下载插件包</a>
                    <a className="lp-btn lp-btn-secondary" href="/plugins/cartula/latest.json">版本索引 latest.json<ArrowUpRight size={14} /></a>
                  </div>
                  <p className="lp-fine">索引里有当前版本、SHA-256 和内容寻址的下载地址；更新由宿主或你的安装器决定。</p>
                </div>
                <div className="lp-connect-code">
                  <CodeBlock lang="text" label="包结构" code={pluginTree} />
                  <CodeBlock lang="json" label="mcp.json" code={pluginMcp} />
                </div>
              </div>}
              {tab === 'skill' && <div className="lp-connect-grid">
                <div className="lp-connect-copy">
                  <h3>Agent Skill：一份指南，三种读法</h3>
                  <p>SKILL.md 讲清创建、图层协作、道路解算、跨天配色、增量编辑和错误恢复。装到支持 Agent Skills 的平台，或让 Agent 通过 MCP 现读。</p>
                  <ol className="lp-howto">
                    <li>下载 <code>SKILL.md</code> 或 ZIP，交给平台的 Skill 安装入口；安装后仍需配置 MCP 连接。</li>
                    <li>只连了 MCP：调用 <code>get_guide({'{'}section{'}'})</code> 按节读取，或让宿主读取资源 URI。</li>
                    <li>指南按内容哈希版本化。本地文件和服务端不一致时，<code>get_guide</code> 拿到的是当前版本。</li>
                  </ol>
                  <div className="lp-actions">
                    <a className="lp-btn lp-btn-primary" href="/skills/cartula/SKILL.md" download><Download size={15} />下载 SKILL.md</a>
                    <a className="lp-btn lp-btn-secondary" href="/skills/cartula.zip" download>下载 ZIP</a>
                    <a className="lp-btn lp-btn-ghost" href="/llms-full.txt">在线阅读<ArrowUpRight size={14} /></a>
                  </div>
                </div>
                <div className="lp-connect-code">
                  <CodeBlock lang="text" label="通过 MCP 读取" code={skillCall} />
                </div>
              </div>}
              {tab === 'rest' && <div className="lp-connect-grid">
                <div className="lp-connect-copy">
                  <h3>REST：任何会发请求的东西</h3>
                  <p>脚本、后端服务、定时任务都能直接读写地图。接口由 OpenAPI 3.1 描述，凭据放在 <code>Authorization: Bearer</code>。</p>
                  <ol className="lp-howto">
                    <li><code>POST /api/spaces</code> 申请空间密钥，保存好。</li>
                    <li><code>PUT /m/{'{id}'}</code> 写整张图；<code>PATCH /m/{'{id}'}</code> 带 <code>baseVersion</code> 局部修改。</li>
                    <li><code>GET /m/{'{id}'}?since=</code> 读增量；<code>view=affected</code> 只取受影响的对象。</li>
                  </ol>
                  <div className="lp-actions">
                    <a className="lp-btn lp-btn-primary" href="/openapi.json">OpenAPI<ArrowUpRight size={14} /></a>
                    <a className="lp-btn lp-btn-secondary" href="/llms.txt">llms.txt<ArrowUpRight size={14} /></a>
                  </div>
                </div>
                <div className="lp-connect-code">
                  <CodeBlock lang="bash" code={curl} />
                </div>
              </div>}
            </div>
          </div>
        </div>
      </section>

      {/* 开源 */}
      <section id="open-source" className="lp-section lp-section-alt">
        <div className="lp-wrap lp-oss">
          <div className="lp-oss-copy">
            <p className="lp-eyebrow">开源</p>
            <h2>{LICENSE_NAME} 协议开源，可以自己部署。</h2>
            <p className="lp-section-sub">源码在 GitHub。一个 Node.js 进程加 SQLite 就能跑起来，Dockerfile 和 Docker Compose 都在仓库里。地图默认私有，服务端只保存凭据摘要。</p>
            <div className="lp-actions">
              <a className="lp-btn lp-btn-primary lp-btn-lg" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"><GitHubMark size={17} />GitHub 仓库</a>
              <a className="lp-btn lp-btn-secondary lp-btn-lg" href="/llms.txt">给 Agent 读的 llms.txt</a>
            </div>
            <ul className="lp-oss-links">
              <li><a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">LICENSE ({LICENSE_NAME})<ExternalLink size={12} /></a></li>
              <li><a href={`${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noopener noreferrer">第三方组件声明<ExternalLink size={12} /></a></li>
              <li><a href={`${REPOSITORY_URL}/blob/main/README.md`} target="_blank" rel="noopener noreferrer">README · 部署与协议细节<ExternalLink size={12} /></a></li>
              <li><a href="/openapi.json">openapi.json</a></li>
            </ul>
          </div>
          <div className="lp-oss-code">
            <CodeBlock lang="bash" label="自托管" code={selfHost} />
            <p className="lp-fine">底图与路网数据来自 OpenStreetMap 贡献者及部署所配置的瓦片、路由供应方；MapLibre GL、deck.gl、React、Fastify 等组件保留各自许可证。</p>
          </div>
        </div>
      </section>

      {/* 收束 */}
      <section className="lp-section lp-cta">
        <div className="lp-wrap lp-cta-inner">
          <h2>让你的 Agent，第一次把路画出来。</h2>
          <p>打开演示画布看看回路怎么转，或者直接把 MCP 地址填进宿主。</p>
          <div className="lp-actions lp-actions-center">
            <a className="lp-btn lp-btn-primary lp-btn-lg" href="/app">打开演示画布<ArrowRight size={16} /></a>
            <a className="lp-btn lp-btn-secondary lp-btn-lg" href="#connect">接入你的 Agent</a>
          </div>
        </div>
      </section>
    </main>

    {/* 页脚 */}
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-inner">
        <div className="lp-footer-brand">
          <Logo />
          <p>人和 Agent 共用的地图画布。</p>
          <a className="lp-footer-gh" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"><GitHubMark />vibe-lark/Cartula</a>
        </div>
        <nav className="lp-footer-cols" aria-label="页脚导航">
          <div>
            <strong>产品</strong>
            <a href="/app">演示画布</a>
            <a href="/app?new=1">新建地图</a>
            <a href="#showcase">交互示意</a>
          </div>
          <div>
            <strong>接入</strong>
            <a href="#connect">MCP</a>
            <a href="/plugins/cartula.zip" download>Agent Plugin</a>
            <a href="/skills/cartula/SKILL.md" download>Agent Skill</a>
            <a href="/openapi.json">OpenAPI</a>
            <a href="/llms.txt">llms.txt</a>
          </div>
          <div>
            <strong>开源</strong>
            <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href={`${REPOSITORY_URL}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">LICENSE</a>
            <a href={`${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md`} target="_blank" rel="noopener noreferrer">第三方声明</a>
          </div>
        </nav>
      </div>
      <div className="lp-wrap lp-footer-bottom">
        <span>© 2026 Cartula contributors · {LICENSE_NAME} License</span>
        <span>Cartula v{RELEASE_VERSION}</span>
      </div>
    </footer>
  </div>;
}
