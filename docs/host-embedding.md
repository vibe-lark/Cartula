# 在 MCP 宿主里嵌入 Cartula：踩过的坑与有效的做法

> **2026-09-09 最终状态补充：** Codex 的 240px 内嵌问题已通过两个资源 metadata 修复并由用户截图确认 736×720；这是用户明确授权的新决定，取代旧 README/复测记录里“不得加私有尺寸字段”的决定。beta.10 保留这两个字段，诊断默认关闭。Codex 全屏白屏按宿主显示问题追踪，具体证据与边界见下文 Codex 小节。通用 API、交接、环境和协作教训见 [integration-lessons.md](integration-lessons.md)。下文 Claude 的过高问题与 Codex 的过矮问题是两条不同原因链。

2026-09-08/09 修「Claude 里地图卡片高到要滚好几屏，同一个资源在 Codex 里只剩一条」时攒下来的。**连修四轮才打中要害**，其中三轮修的都不是主因。这篇的目的是让下一个碰这块的人不用重新推一遍。

代码入口：`src/web/adapters/host-size.ts`（尺寸协商）、`src/web/styles.css` 的 `--app-height`、`src/server/mcp.ts`（资源发布）、`src/web/mcp-host.ts`（本地模拟宿主）、`src/web/adapters/diagnostics.ts`（诊断读数）。

2026-09-19 的豆包卡片「有路线、无底图」是另一条 Worker 原因链；复现、最小兼容修复和实机验收步骤见 [mcp-worker-compatibility.md](mcp-worker-compatibility.md)。

---

## 1. 结论：根因是哪一条

**根因是 `73df4c5` 把 `axisRequest` 从 `min(target, bound)` 改成「吃满整个弹性上限」。** Claude Desktop 发 `containerDimensions.maxHeight = 5000`，于是 app 申请 5000，CSS 里 `max-height:var(--host-max-height,none)` 也解析成 5000px。5000px ≈ 六屏，就是用户看到的东西。

`22fdc7a` 把 `min()` 恢复回来，核心就已经修好了。

后面几轮做的这三件事**是有价值的副产品，但都不是主因**——写清楚是因为很容易有人以为修复在这三项里：

| 改动 | 解决的问题 | 是不是主因 |
|---|---|---|
| `min(target, bound)`（22fdc7a 恢复） | 宿主给 5000 就申请 5000 | **是** |
| fixed 轴也当上限（11c8af1） | 宿主若发固定大高度会铺满 | 否，Claude 发的不是 fixed |
| 资源 URI 带 build（ecf2652 / 8f2d7fb） | 宿主按 URI 缓存，发版对宿主不可见 | 否，但它是「为什么前两轮看不到效果」的原因 |
| 不宣告 `listChanged`（e34d1f3） | 宣告了发不出的通知，等于请客户端永久缓存 | 否 |

**「尺寸尽量大」指的是别缩手缩脚地少要，不是把宿主给的额度全用光。** 宿主声明的是「它有多少地方」，不是「这张卡该占多少」。

---

## 2. 宿主实测行为

以下区分用户/诊断面板实测与安装包源码核对。源码支持、协议消息和最终显示是不同证据，不应互相代替。

### Claude Desktop 1.49585.0

```
containerDimensions {"maxHeight":5000,"width":766}
displayMode           inline
```

- 高度是**弹性上限**且极大（≈六屏），宽度是**固定值**（卡片宽）。**不是 fixed height** —— 前三轮我一直往这个方向猜，全错。
- guest SDK：`Claude.app/Contents/Resources/app.asar` → `/.vite/build/index.chunk-BiV0jkNg.js`，MCP Apps protocolVersion `2025-11-21`（我们的 ext-apps 1.7.5 声明 `2026-01-26`，仍然能工作）。
- 它的 `setupAutoResize` 量的是 `document.body.getBoundingClientRect().height`，然后发 `ui/notifications/size-changed`。
- **宿主确实响应 size-changed** —— 它自家内置组件唯一的定高手段就是这个。所以 anthropics/claude-ai-mcp#69 那条「Claude 不响应 size-changed」对这个桌面版**不成立**，不要据此做加固。
- **它按 `_meta.ui.resourceUri` 缓存资源，且跨会话存活。** 这是「服务端确认发布成功、用户端毫无变化」的原因。
- 宿主侧 `AppRenderer` 在 claude.ai 的远程 bundle 里，Cloudflare 403 拿不到，只能靠诊断读数反推。
- **不给全屏，两条路都堵死**：声明 `availableDisplayModes: ["inline"]`，**并且**沙箱 iframe 没有授予 `allow="fullscreen"`，所以 `document.fullscreenEnabled === false`。嵌入态拿不到大画布，只能开独立页。

  这和「宿主只声明 inline、但浏览器全屏可用」是**两种不同情况**，模拟宿主要分别覆盖（`modes=inline` 与 `modes=inline&noFullscreen`）。Cartula 现在在渲染时就同步判断这两条路（`main.tsx` 的 `expandable`）：都不通就不画展开按钮，改把「在独立页面打开大画布」作为出口。**`document.fullscreenEnabled` 是同步可读的，不需要先失败一次才知道。**
- `ui/open-link` 的落点由宿主决定。app.asar 里确实有把链接路由进侧边栏的 IPC（`focusOrOpenPreviewTab` / `openExternalLinkInPreview` / `setPreviewLinkRouting(serverId, routed)` / `openRoutedLinkExternally`），但参数是 `previewId`/`serverId`/`cwd`，属于 Claude Code 的 preview 面板，**没有对 MCP App 开放**；artifact 桥接里所有非 `cowork-artifact:` 链接都被 `preventDefault()` 后走 `openExternalUrl` → `shell.openExternal`。**Cartula 控制不了，不用改。**

### 沙箱 iframe 里的剪贴板（2026-09-14 实测）

用户报告：在宿主卡片里点任何「复制」都提示无法复制，同一个页面在浏览器里正常。

在本地模拟宿主（`mcp-host.html`，`sandbox="allow-scripts allow-downloads"`，与 Claude Desktop 同形状——**不给 `allow-same-origin`，所以 `location.origin === "null"`，是不透明来源**）里量到的是：

```
isSecureContext   true
origin            "null"
navigator.clipboard.writeText   NotAllowedError
document.execCommand('copy')    true
```

- **异步剪贴板 API 被拒**：`clipboard-write` 权限策略的默认 allowlist 是 `self`，卡片在宿主的跨源 iframe 里，宿主没有（也不会为每个 App）加 `allow="clipboard-write"`。**这不是 Cartula 能申请的权限** —— 提示框属于顶层页面，MCP Apps 协议里也没有申请剪贴板的消息。
- **旧的 `document.execCommand('copy')` 仍然有效**：它不受权限策略管辖，只要有用户手势和一个**真正被渲染出来的**选区。`display:none` / `visibility:hidden` 的元素选不中，复制会静默失败——临时 textarea 必须用 `position:fixed` + `opacity:0`。
- 所以 Cartula 的复制是三段阶梯（`src/web/components/clipboard.ts`）：异步 API → `execCommand` → 都不通就**就地选中文本并提示手动按 Ctrl/⌘+C**。任何要交出去的值（分享链接、给 Agent 的说明、继续规划消息、密钥与配置）都必须**始终显示在可选中的输入框里**，复制只是快捷方式，不是唯一出路。
- 回归覆盖：`tests/e2e/embedding.spec.ts`「a card copies its share link through the route a sandboxed host still allows」先断言 `NotAllowedError` 这个前提仍然成立，再断言卡片照样复制成功；`tests/clipboard.test.ts` 覆盖三段阶梯本身。

### Codex（com.openai.codex 26.901.51231）

- 初始 240 / 下限 200 / 上限 720，公式 `min(max(intrinsicHeight ?? heightHint ?? 240, minFrameHeight ?? 200), 720)`。常量在 `webview/assets/app-primary-*.js`。
- 把 `containerDimensions.maxHeight` 设成当前 `element.clientHeight` **回灌**，所以框一旦小就自锁在 240：`declarePreferredSize(720)` 会被压成 `min(720,240)`。
- 走 `openai/outputTemplate` 找资源。


#### 已验证的 720px 兼容修复

源码提交 `6374b6d`（beta.9），在 `src/server/mcp.ts` 的公共 `appPage` 回调返回的 **HTML 资源项 `contents[i]._meta`** 合并：

```json
{
  "openai/widgetHeightHint": 720,
  "openai/widgetMinFrameHeight": 720
}
```

它们不是工具输入参数，也不能只放在工具声明 metadata 中。当前 URI、旧 `map.html` 和历史 URI 回退共用这一生成点；原有 `ui`、CSP 与标准尺寸协商保留。hint 提供初始高度，minFrameHeight 在所核对的 Codex 计算分支中避免测量值再次把帧压小。

证据：Codex `26.901.51231` / build `8109` 的实现有这两个字段的读取与高度计算；发布后用户截图为 `containerDimensions={maxHeight:720,maxWidth:736}`、`displayMode=inline`、body/documentElement 实测 **736×720**。两字段合并使用已验收，未做逐字段独立归因。它们是当前版本的内部兼容项，不是 MCP Apps 标准，也不是其他宿主或后续版本的保证。

收尾独立读取 beta.10：`release=0.3.0+bd4de1e`，资源 `ui://cartula/map.0.3.0-bd4de1e.html`，SHA256 `0e81731011fdd11f745cd1de24352a704c1e3e0f122b65cc0e29e6d7e115dce2`；两个值仍为 720，bootstrap 不启用 diagnostics。用户已明确授权保留该修复，不应按旧报告回退。

#### 全屏侧栏白屏：现象已记录，根因未完全定位

Codex 把 `displayMode=fullscreen` 的 MCP App 放到侧栏；日志显示这次创建了新的沙箱视图。这不等于打开独立地图网址，也不等于调用浏览器 Fullscreen API。

用户先报告长时间白屏后恢复，后补充：点击全屏后切到另一个会话，再切回来，地图立即显示。这一用户对照更支持宿主重绘/可见性更新问题；代理没有直接复现该操作或拿到沙箱内部渲染跟踪。

本轮日志（2026-09-09，UTC；本地 UTC+8）记录：

| 时间 / 阶段 | 证据与边界 |
|---|---|
| 07:53:31.756 | 宿主请求新沙箱 |
| 07:53:31.847–32.241 | Codex 主窗口 `rendererWebContentsId=1` 在 394ms 内记录 11 次 `ResizeObserver loop completed with undelivered notifications.`；并非已定位到 Cartula 脚本的错误 |
| 07:53:32.255 | 同一会话资源读取成功，406ms，排队 0ms |
| 07:53:33.610 | 宿主记录 `widget_running`，距请求 1.85s；不代表地图已经绘制 |

同类 ResizeObserver 错误当天另有大量记录，不能仅凭它认定白屏根因或认定新高度 metadata 导致问题。普通浏览器接口未列出这个 MCP 视图，拿不到其控制台和请求瀑布。额外普通诊断标签访问 `/healthz` 时的 `ERR_BLOCKED_BY_CLIENT`、代理查询浏览器路由的错误、以及当天 07:20 的旧 HTTP 503，均不能冒充此次全屏白屏的原因。

当前按 Codex 宿主显示问题追踪，不据此给 Cartula 加强制刷新/重载补偿。没有已确认必须继续修改的 Codex 专用适配项，不等于所有宿主交互边界均已通过。

---

## 3. CSS 的三个坑

**这三条是同一个 bug 的三次错误修法，是按顺序踩下来的。**

1. **`min-height` 压过 `max-height`。** 想用 `min-height:720px` 给「无约束时」兜底，结果宿主给 240 上限时被它顶掉，变成违反宿主约束。封顶不能靠 `min-height`。
2. **根元素 `html` 上 `max-height` 压不住 `height`。** 实测 `html{height:720px;max-height:240px}` 计算结果是 `719.993px`。封顶要么落在普通元素（`#root`）上，要么直接写 `height`。
3. **`var(--x, 720px)` 是「变量缺失时的兜底」，不是封顶。** 宿主给 5000 时变量有值、兜底根本不参与，结果还是 5000。**必须用 `min()`。**

现在的写法（`styles.css`）：

```css
html[data-embedded]:not([data-display-mode="fullscreen"]):not([data-browser-fullscreen]){
  --app-height: min(
    var(--app-max-height),                          /* 我们自己的天花板 720px */
    var(--host-height,     var(--app-max-height)),  /* 宿主固定高，缺省不参与 min */
    var(--host-max-height, var(--app-max-height))   /* 宿主弹性上限，同上 */
  )
}
html,body,#root{height:var(--app-height,var(--host-height,100%))}
```

要点：

- 每个 `var()` 的兜底都必须是**天花板本身**，否则宿主没声明的那一项会把 min 拉到 0。
- 落在 `html`/`body` 上（而且是 `height` 不是 `max-height`），因为有些宿主是量文档来定高的，只封 `#root` 的话 `documentElement` 仍然报整个框高。
- 挂在 `data-embedded` 上，这个属性由 bootstrap **同步**写入（`main.tsx`），所以不依赖握手是否成功、也不依赖宿主发了什么 `displayMode`。曾经挂在 `data-display-mode="inline"` 上，宿主发别的值或不发就静默失效——失效方式和 bug 本身长得一模一样。

---

## 4. 协议与 SDK 的坑

4. **SDK 的 `setupSizeChangedNotifications` 测量前会把 `documentElement.style.height` 设成 `max-content` 再还原。** 内联样式优先级最高，会绕开任何写在 `html` 上的 CSS 封顶。所以**开 `autoResize` 时，`body` 的自然高度本身必须已经被约束住**，否则它上报的是完整内容高度。

   Cartula 目前 `autoResize: false`，自己发 `size-changed`。注意「保留申请更宽卡片的能力」**不是**关闭理由：固定宽度轴（Claude 发 `width: 766`）上 `axisRequest` 本来就跳过宽度申请，想要更宽只能走 `ui/request-display-mode`；弹性宽度轴上 SDK 也只会把量出来的框宽报回去。真正的理由是上面那条 `max-content` 测量路径会绕开 CSS 封顶，重开 autoResize 等于重开「卡片吃满宿主弹性上限」的 bug。高度轴上两者按构造等价（`--app-height` 把 `body` 钉在 `resolveSizeRequest` 上报的同一个数上，e2e 逐形状断言）。

5. **`containerDimensions` 是 Zod union：`{height} | {maxHeight}`、`{width} | {maxWidth}`。** 同一轴上两个 key 互斥，没中的那个会被**剥掉**。所以宿主不可能同时发 fixed 和 elastic；构造这种测试用例是在测一个到不了 app 的东西。

6. **宣告了发不出的能力 = 请客户端永久缓存。** `/mcp` 是无状态的（每个 POST 新建 server、无 `mcp-session-id`、`GET /mcp` 返回 405、响应是 JSON 不是 SSE），**发不出任何通知**。而 SDK 在 `registerTool`/`registerResource` 里无条件写 `listChanged: true`，那是一句关于传输层的承诺：「列表变了我会通知你」，客户端据此可以一直缓存。工具定义里带着 `_meta.ui.resourceUri`，所以缓存工具列表 = 缓存「该渲染哪个 App」。现在 `withoutUndeliverableNotifications()` 把它改成 `false`，并有测试走真实传输断言握手内容（改的是 SDK 私有字段，上游改名会让它悄悄失效）。

7. **版本化资源 URI 会让上一版 URI 失效，而客户端缓存的正是那个 URI。** 这是修复过程中**新引入**的隐患：发布 `e34d1f3` 后 `ui://cartula/map.0.3.0-ecf2652.html` 直接报错，缓存了旧 `resourceUri` 的宿主下次渲染拿到「资源不存在」——比拿到旧内容更糟。现在用一个**不列入 `resources/list`** 的 ResourceTemplate `ui://cartula/map.{version}.html` 兜住所有历史地址，一律返回当前构建；`resources/list` 里只公布当前地址。

   版本化本身依赖部署设置 `CARTULA_BUILD`，不设的话同一版本所有 build 共用一个名字，等于没做。

---

## 5. 测试方法学的坑（这几条最值钱）

8. **测试宿主硬编码资源 URI。** `src/web/mcp-host.ts` 以前直接 `readResource({uri: 'ui://cartula/map.html'})`，于是「服务端发布了一个宿主根本找不到的 App」这类故障，**全套 e2e 一个都发现不了**。现在改成从工具结果 `_meta` / 工具定义里**发现** URI，发现不到就报错。**写宿主侧测试时，不要硬编码任何宿主本该自己发现的东西。**

9. **把 bug 当正确行为验收。** 第一轮的测试矩阵里，宿主给 fixed 1600 被断言成「渲染 1600 是对的，那是宿主的决定」，还写进了回报。**测试断言了错误的期望，比没有测试更危险——它给 bug 背书**，并且让后续每一轮都绕过这一档。

10. **从没测过「弹性且上限极大」这一档。** 测过 `maxHeight:1600`、`maxHeight:240`、fixed 500、fixed 1600，真实值是 **5000**。矩阵看着很全，却漏了真实世界里唯一会出现的那个形状。这是连修三轮没打中要害的直接原因。**现在 `{maxHeight: 5000, width: 766}` 是固定用例**（`tests/mcp-adapter.test.ts` 与 `tests/e2e/embedding.spec.ts`，注释里写明来源）。

11. **只量 `#root` 不够。** 不同宿主看的元素不同（Claude 的 guest SDK 量 `body`），要同时记录 **`body` / `documentElement` / `#root` / iframe** 四个值。只量 `#root` 时，「`#root` 封到 720 了但 `documentElement` 还是 1600」这种半修复看起来是通过的。

**通用教训：拿不到真实数值就先想办法量，不要靠推断补测试。** 每一轮我都是按「宿主大概发的是 X」这个假设加固，然后给矩阵添一档假设出来的用例。真实读数一到位，答案一眼就有了。

---

## 6. 验证有效的做法

### 可切换宿主行为的本地模拟宿主

`src/web/mcp-host.ts` + `/mcp-host.html?id=<地图ID>#key=<editKey>`。查询参数（组合使用）：

| 参数 | 含义 |
|---|---|
| `noDims` | 宿主完全不声明 containerDimensions |
| `w` / `h` | 固定轴（宿主拥有该轴） |
| `maxw` / `maxh` | 弹性轴上限 |
| `deaf` | 收到 `size-changed` 但什么都不做（靠量文档定高的宿主） |
| `modes=a,b` | 宿主声明的 `availableDisplayModes`；`modes=`（空）表示一个都不声明 |
| `display=deny` | `ui/request-display-mode` 一律答 inline |
| `display=host` | 宿主自己切换显示模式，不走浏览器 Fullscreen API |
| `noFullscreen` | iframe 不带 fullscreen 权限（`document.fullscreenEnabled === false`）|
| `noMessage` / `message=reject` / `message=timeout` | ui/message 的三种宿主行为 |
| `noWorkers` | 屏蔽 worker，走 SVG 回退 |

**比读代码猜快得多。** 复现 Claude 的尺寸：`?id=…&maxh=5000&w=766`；复现 Claude 的全屏封死：`?id=…&maxh=5000&w=766&modes=inline&noFullscreen=1`；复现 Codex：`?id=…&maxh=240`。

### 诊断读数面板

部署侧设 `CARTULA_DIAGNOSTICS=1`（beta 的 ConfigMap 一行），卡片上出现读数面板，同时镜像到 `<html data-cartula-size="…">`。默认关闭。

```
containerDimensions {"maxHeight":5000,"width":766}   ← 宿主原样发来的
displayMode inline
availableDisplayModes ["inline","fullscreen"]        ← 宿主允许什么（不是 app 支持什么）
全屏请求 已发送，宿主答 granted (fullscreen)；未尝试浏览器全屏
申请 已发送 —×720                                    ← 我们发出去的 size-changed
本应申请 {"height":720}
算出的渲染尺寸 766×720
body 实测 766×720
documentElement 实测 766×720
documentElement client/scroll 高 720/720             ← 这两个受视口下限影响
--app-height min(720px,720px,5000px)                 ← 自定义属性读回来是 token 流
```

怎么读：

- **诊断入口由 bootstrap 驱动，不依赖 MCP 握手。** 看不到面板时先核对当前构建是否启用 diagnostics、宿主实际资源、脚本执行与页面绘制。诊断已关闭、脚本未执行或宿主尚未绘制都可能不显示面板，不能仅据此断言“HTML 没加载”或排除 App 内部问题。
- `documentElement client/scroll 高` 若远大于 `documentElement 实测`，说明框是宿主自己撑着的，它既没听我们的上报也没按文档量。
- `--app-height` 显示的是未求值的 token 流（自定义属性就是这样读回来的），好处是三个输入一目了然。

**这一步早做能省两轮发版。** 前两轮都是在没有真实 hostContext 的情况下靠推测改的。

### 独立核验发布

不要采信任何一方的口头回报，自己拉：

```bash
curl -s https://cartula.dev.solutionsuite.cn/healthz          # release 是不是新的
# 再用 MCP resources/read 拉 ui://cartula/map.<release>.html 自己算 sha256
```

这次正是靠它才确认「发版是真的、但宿主渲染的不是这份」。**服务端 sha256 对得上 ≠ 宿主渲染的是这一份。**

### 扒宿主安装包拿真实常量

- Codex：`com.openai.codex` → `webview/assets/app-primary-*.js`
- Claude：`Claude.app/Contents/Resources/app.asar` → `/.vite/build/index.chunk-BiV0jkNg.js`（guest SDK；宿主侧 `AppRenderer` 在远程 bundle，拿不到）

---

## 7. 现在的契约（一句话版）

- 下述固定轴也作为上限的处理是 Cartula 当前产品实现选择，不是 MCP Apps 规范把固定/弹性轴视为相同语义。
- 每个轴按 `min(目标, 宿主声明的每一个界)` 申请，`width`/`height`（固定）和 `maxWidth`/`maxHeight`（弹性）**一视同仁都当上限**。
- 渲染小于宿主固定值时**仍然上报**，好让宿主把余下空间收回去；比固定值更大则不申请（那是 `ui/request-display-mode` 的事）。
- 同一个数字在 CSS 里是 `--app-height`，封住 `html`/`body`/`#root`。
- 资源发布在 `ui://cartula/map.<release>.html`；旧地址和任何历史版本地址都继续解析、返回当前构建。
- 不宣告 `listChanged`。
- 展开入口按能力渲染：宿主 `availableDisplayModes` 含 `fullscreen`、或 `document.fullscreenEnabled` 为真，才画；都不成立就只给独立页入口。`availableDisplayModes` 未发送**不算**拒绝（实测这种宿主会答 granted），照画。
