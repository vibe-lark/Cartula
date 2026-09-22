# Cartula

人与 Agent 共用的地图画布。Agent 传入路线、地点与 GeoJSON；用户直接在图上编辑；Agent 读取 `changes` 后继续规划。

源码：<https://github.com/vibe-lark/Cartula>，MIT 协议开源（[LICENSE](LICENSE)），第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 运行

需要 Node.js 22.13+（使用内置 `node:sqlite`，Node 22 可能打印实验特性提示）。

```bash
npm ci
npm run build
BASEMAP_STYLE=liberty npm start
```

打开 http://localhost:3900。`/app` 提供大小兴安岭演示，首次编辑时保存地图。无需登录即可使用：Cartula 分配持久的空间 `spaceKey`，同一 key 可以创建、读取和编辑多张地图。Agent 保存并复用它；浏览器保留未认领空间的凭证。数据默认保存到 `data/cartula.sqlite`。

新地图默认私有，普通 `url` 和地图 ID 不授予访问权限。`editUrl` 携带 owner key，只交给地图主人；分享时点击分享入口生成独立的 `previewUrl`。

分享弹窗的「允许对方编辑」决定这条链接的权限，两种都只打开这一张地图：

- 不勾选（默认）：对方可以查看、导出、收藏或复制，不能修改原图。
- 勾选：对方和对方的 Agent 可以修改这张地图的图层、地点与路线，改动记在他自己名下。仍然不能删除地图、再生成分享、认领空间，也看不到空间密钥。

生成后弹窗给出两样东西，都在可选中的输入框里：「分享链接」和「分享给 Agent」（后者点名 `previewToken`，对方的 Agent 只读这段文字也能直接调用 `get_map`）。右侧图标复制——在 MCP 宿主的沙箱 iframe 里 `navigator.clipboard` 会被 `clipboard-write` 权限策略拒绝且无法申请，所以复制会自动退到 `document.execCommand('copy')`，两条路都不通时就地选中文本并提示手动按 Ctrl/⌘+C。

弹窗下方列出这张地图现有的全部分享：生成日期、只读还是可编辑，每条可以单独停用，「停用全部分享」一次收回所有。**列表不含链接地址**——令牌明文只在生成的那一次返回，服务端只留摘要，之后谁也取不回来；忘了就重新生成一条，再把旧的停用。

多人协作请用可编辑分享，不要把 `spaceKey` 或 `#space=` 链接发出去——那把钥匙开的是整个空间的每一张地图，带删除权，而且没有撤销手段。复制得到独立地图，之后与原图分别修改。

点击账号入口可用邮箱、密码和密码确认注册。邮箱用于登录标识，不发送验证邮件；密码为 12–128 字符，包含大小写字母、数字和非空白符号。在结果页点击“保存到账号”会认领该 key 对应的整个空间，多张地图会一起保存；Agent 原有 key 继续有效。已保存地图从账号里的“我的地图”访问；收藏依赖原分享授权，分享被停用后不可再读取，已经复制的地图继续保留。

受限网络可向进程传入 `TILE_PROXY_URL`，例如现有的出网代理地址。`.env.example` 给出可配置项；Docker Compose 会读取 `.env`，直接运行 Node 时请通过 shell 传入环境变量。

开发时先 `ALLOWED_ORIGINS=http://localhost:5173 npm run dev`，另一终端 `npm run dev:web`。

## Agent：读一个例子即可使用

```bash
# 先申请空间，将返回的 spaceKey 保存在自己的凭证存储中。
curl -X POST http://localhost:3900/api/spaces \
  -H 'Content-Type: application/json' --data '{}'

# CARTULA_SPACE_KEY 使用上一步返回的值；后续地图继续使用同一个 key。
curl -X PUT http://localhost:3900/m/my-trip \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $CARTULA_SPACE_KEY" \
  --data-binary @examples/xinganling.json
```

响应包含地图、`url`、`version` 和 `access`。也可以不带 key 一次创建地图并获得新空间凭证；该 key 仅在创建响应中交付。希望可靠重试时，先申请并保存空间 key，再发起地图写入。

```json
{
  "title": "大小兴安岭路线对比",
  "layers": [{
    "name": "小兴安岭 6 天",
    "points": [
      { "name": "哈尔滨", "at": [126.642, 45.757], "day": 1 },
      { "name": "伊春", "at": [128.899, 47.725], "day": 2 },
      { "name": "黑河", "at": [127.499, 50.250], "day": 6 }
    ]
  }]
}
```

读写时添加 `Authorization: Bearer <spaceKey>`。密钥由 Cartula 分配，不接受调用方自造的未知 key。`GET /api/maps` 携带空间 key 可以列出同空间地图；登录账号使用会话 cookie 查看名下地图和收藏。`DELETE /api/maps/{id}` 是所有者专用的彻底删除：地图、全部历史版本、全部分享链接与基于分享的收藏一并消失，正在订阅的 WebSocket 会被关闭，无法恢复。

用户说“我改好了”后：

```bash
curl 'http://localhost:3900/m/my-trip?view=summary' \
  -H "Authorization: Bearer $CARTULA_SPACE_KEY"
```

响应包含最新 `layers`、`changed`、中文 `changes` 和结构化 `events`。`changed` 表示相对返回的 `sinceVersion` 是否有更新，包含用户与 Agent 的修改；兼容字段 `unchanged` 始终与之相反。需要区分来源时使用 `hasUserChanges` / `hasAgentChanges`。这修正了旧版 `changed` 只统计用户事件、可能遗漏 Agent 增量的行为。

地图被可编辑分享之后就不止一个写入方，`actor` 只说明是 Agent 还是用户，不再能说明是谁。每个版本另外记录 `event.author`（稳定标识，不是凭据），读取响应的 `access.authorId` 就是调用方自己：两者相同的版本是自己写的，不同的是协作者写的。不传 `since` 的默认增量窗口也按 author 分别记录，因此协作者的 Agent 写入不会让你的 Agent 漏看自己没读过的改动。早于该字段的历史版本没有 `author`。

不传 `since` 时读取窗口是调用方自己最近一次写入之后的变化（没写过则回落到该图最近一次 Agent 写入，与旧行为一致）。`?since=2` 则读取 v2 之后的全部事件；读取不会清空变化。摘要分页有 `moreEvents/nextSince`。HTTP 默认 `view=full` 保持兼容，可选 `summary`（无几何）、`affected`（受影响对象）或 `changes`（仅事件）。MCP 默认摘要。`parent` 指向前一个版本；历史快照在数据库保留，当前没有历史过期或自动清理机制。

地图 ID 可由调用方命名，格式为 1–80 位字母、数字、`-`、`_`；ID 只用于定位。空间 key 授权整个空间，独立 `previewToken` 只授权一张地图的读取。所有读取视图、导出、实时订阅和 MCP 隐藏快照都校验权限。分享链接用 `#preview=...`，owner 链接用 `#space=...`，凭证不放在 query 参数中。服务器保存凭证摘要，不保存明文 key。显式传入的凭证必须匹配当前地图；错误 key 不自动借用登录会话。本图 previewToken 即使与所有者会话同时发送，也保持只读。

## 写入、版本与冲突

- 相同 PUT 载荷自动去重。即使后来用户编辑过，重试旧 PUT 也只返回最新地图，不覆盖用户编辑。
- 如果确实要重新应用曾经写过的内容，传一个新的 `Idempotency-Key`。同一键配不同内容返回 `409`。
- 可选 `If-Match: "2"` 防止覆盖并发编辑，值来自 GET 的 `ETag`。不传时，新的 Agent 写入表示明确替换整份地图。
- Agent 局部更新使用 `PATCH /m/{id}` 或 MCP `patch_map`，携带 `baseVersion`、`operations` 和可选 `requestId`，仅更新涉及的对象，记录 `actor=agent`；重试不会覆盖后来用户改动。
- 用户编辑走语义事件和 `baseVersion`，服务端原子提交；冲突返回 `409`，不自动丢弃远端变化。
- 在线页面显示保存或请求失败；网络中断时，服务端是否已写入可能尚未确认。已保存的数据不依赖 WS，断线/重连由 GET 补齐；保留页面并使用原尝试重试可利用请求去重。完全离线创作请使用离线 HTML。

编辑操作及其点位、路由、路段载荷严格校验未知字段，出错时整批拒绝并指出字段路径。`layer.update.patch` 不接受 `points`；常用形状如下（示例图层有 `a1/a2/a3` 三个点）：

```json
[
  {"op":"point.update","layerId":"plan-a","pointId":"a2","patch":{"day":3,"note":"住一晚"}},
  {"op":"point.reorder","layerId":"plan-a","pointId":"a3","toIndex":0},
  {"op":"points.reorder","layerId":"plan-a","pointIds":["a3","a2","a1"]},
  {"op":"intent.set","scope":"map","text":"每天少开车","priority":"prefer"}
]
```

`point.reorder` 移动一个点；新增的 `points.reorder` 接受完整排列，重复、遗漏或不存在的 ID 都会拒绝。它调整顺序，不自动改写每个点的 `day`。全量 GET → PUT 仍允许携带快照派生字段；`layer.add` 为撤销兼容接受并丢弃明确列出的派生字段，GeoJSON 仍允许标准扩展和自由 `properties`。

可选字段：`kind: "spots"` 散点、`kind: "geojson"`、`color: "#d98324"`、`from` 溯源文本、`note`、`visible`、`crs: "gcj02"`；节点支持 `day`、`note`、`warn`、HTTPS `img`、`intent` 规划意图、`flexibility: "fixed" | "flexible"`（必须保留／允许调整）、`icon` 自定义标记（`pin` / `hotel` / `restaurant` / `cafe` / `viewpoint` / `museum` / `park` / `parking` / `fuel` / `airport` / `station` / `camp` / `shop` / `hospital` / `note`）；图层也支持 `intent`。`spots` 图层在地图上显示为图钉，不连线、不编号。底图 POI 保持不可交互，只有 Cartula 节点可点选。GeoJSON 放在 `layer.geojson`（FeatureCollection），支持 Point/MultiPoint/LineString/MultiLineString/Polygon/MultiPolygon。`layer.path` 可传调用方提供的道路几何坐标数组。服务端不抓取任意数据源 URL。

点击地点弹出的卡片按固定槽位呈现这些字段：`name` 标题、`day`/`warn`/`flexibility` 徽章、`img` 图片、`note` 正文、`intent` 规划意图、下一段路程与操作按钮。图片经 Cartula 的 `/img` 代理加载，只接受公网 HTTPS 的 PNG/JPEG/WebP/AVIF/GIF；Agent 不能自定义按钮、HTML 或 Markdown。

`at` 一律 `[经度, 纬度]`；默认 WGS84。GCJ02 输入转换后以 WGS84 持久化。路线无 `path` 时，若已配置 OSRM，Cartula 会按相邻停靠点解算道路几何和车程；解算失败或未配置时按节点顺序直连，距离显示**直线估算**。调用方提供的 `path` 不由 OSRM 覆盖，几何长度与路由服务指标分别保存。移动／增删／重排路线节点时清除旧 `path` 和 `routing`，并自动重算。天数只在节点指定 `day` 时展示，内部旧 `stats.days` 保持兼容。

坐标配额分两类，不应将几何顶点都称为“停靠点”：

| 类别 | 当前配额 | 超限处理 |
| --- | --- | --- |
| 调用方输入：停靠点 + GeoJSON 顶点 + 新提供／改写的道路几何 | 整图 20,000；每层最多 1,000 个停靠点 | 400，返回类别、阈值、实际数量和纠正建议，不部分写入 |
| Cartula 解算或从既有版本原样保留的道路几何 | 整图 12,000 个规范坐标 | 渐进简化；必要时对显示几何降级并明确报告，保留停靠点、路段关联和供应方指标 |

整线与分段线完全一致时只计一次。`layer.routingStatus` 披露坐标数量、来源、简化容差，以及是否删除分段几何或仅保留整线端点；深度降级后的显示线不能当作完整道路导航轨迹。新建、重新路由和既有地图编辑都执行配额处理。原样回传存量几何不占新输入配额，但它也可能为满足派生配额而被简化；伪造 `routing.source="OSRM"` 不能获得配额豁免。

## 路由里程与车程

将外部路由结果与绘图几何分开传入，简化 `path` 不再影响路由服务里程：

```json
{
  "source": "OSRM",
  "profile": "driving",
  "distanceKm": 1554,
  "durationMinutes": 1080,
  "legs": [{ "fromPointId": "nice", "toPointId": "geneva", "distanceKm": 1554, "durationMinutes": 1080 }]
}
```

以上对象放入 `layer.routing`；`legs` 可选，引用同层相邻地点 ID。总值优先用显式值，否则只在所有路段完整提供同一指标时汇总。页面展示路由里程、纯驾驶时间（其他交通方式使用相应文案）和每段信息，并在详情分别列出直线距离／几何长度／路由里程。路由时间不包含游览、用餐、休息和住宿；未知车程不从距离推算。来源与交通方式按调用方数据标明。

左上角是一列图层圆点，每个图层一个序号，最下面是「新建图层」。圆点是图层色的半透明圆：当前选中的图层实心，隐藏的图层虚线、变淡。鼠标停在圆点上，这个图层的地点列表就浮现在旁边，沿着圆点往下移列表跟着换；移开就收起，看地图不用点任何按钮。点圆点是选中并框住这个图层。列表标题只占一行，标题下一行是路线总里程、时间、天数等汇总，旁边是信息、缩放、显示/隐藏、只看、设置几个按钮；里程和时间的依据、数据来源、提供方都收在「信息」弹窗里。列表标题旁的图钉把它固定住（记在浏览器里），触屏没有悬停，点圆点打开、点关闭收起。

多条路线可通过顶部“只看”和“对比路线”直接比较，只看一条路线仍保留候选地点图层。默认按方案色系、方案内按日期分色；也可切换为每个方案单色。普通地点提醒与已知拥堵／封闭使用不同表达；`traffic="unknown"` 不代表路况畅通或拥堵。当前仍以已有图层组织方案，不提供持久的 `alternativeGroup`、地理编码或包含连住日的完整行程时间模型。

Agent 通常只需传停靠点。`create_map` / `patch_map` 在 `driving` / `walking` / `cycling` 路线缺少 `path` 时，会向 OSRM（默认 `https://router.project-osrm.org`，可用 `OSRM_URL` 换成自建实例）请求道路几何与时间；结果写入地图，但 `get_map` 摘要仍不含坐标。调用方仍可自己传 `path` / `routing`。地理编码仍由 Agent 完成，确认 WGS84 后填 `point.at`。火车、航班、轮渡不会走 OSRM。设置 `OSRM_URL=` 可关闭自动解算。默认公共演示服务只适合打通；生产请换成自建 OSRM。Cartula 是规划画布而不是导航，不会去拉实时拥堵。

通过 `layer.update` 的 `patch.path`／`patch.routing` 设置新数据，`null` 清除。`{op:"intent",text:"把两天加给瑞士"}` 给一次操作附上原因；也可为地点／图层保留长期意图。需要对某一路段加约束时，可将其独立成图层并设置 `intent`。

## WebSocket

连接 `ws://localhost:3900/m/my-trip`（HTTPS 对应 `wss://`）。私有地图需要在握手携带 Bearer / 会话 cookie，或连接后发送 `{"type":"auth","key":"<spaceKey>"}` / `{"type":"auth","previewToken":"<previewToken>"}`。使用会话 cookie 的浏览器可以发 `{"type":"auth"}`。认证前不发送地图版本，认证成功后先返回 `{"type":"auth","ok":true}` 并同步当前版本，此后发送：

```json
{ "type": "edit", "version": 2, "actor": "user", "author": "sp_…", "changes": ["在「黑河」之后插入了「五大连池」"] }
```

拿到通知后调用 GET。浏览器会重连并定期 GET，通知丢失不影响数据完整性。

持有写权限的 Agent（空间密钥、账号，或可编辑分享）可以发送建议；只读分享只允许订阅：

```json
{ "type": "suggest", "text": "建议在五大连池住一晚", "highlight": ["五大连池"] }
```

建议广播给当前查看地图的页面；它是临时消息，不修改路线，不写版本历史。每次通知重新验证访问权限；撤销分享、删除收藏或注销会话后，对应订阅停止接收数据。

## MCP Apps

端点：`http://localhost:3900/mcp`，**Stateless Streamable HTTP**。

```json
{
  "mcpServers": {
    "cartula": {
      "type": "http",
      "url": "https://cartula.dev.solutionsuite.cn/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

`Authorization` 填账号 API Key（登录后在账号面板创建，前缀 `cak_`）或空间密钥 `spaceKey`。宿主配置界面里这一项通常就叫 API Key。客户端配置格式可能不同，请填入同一个 URL 和请求头。上面的 `type: "http"` 是一些 MCP 客户端的本地配置写法；Agent Plugin 根目录的标准 `mcp.json` 使用 `type: "streamable-http"`，两者都连接同一个 `/mcp` 端点。模型工具：

- `create_space({})`：申请空间，保存返回的 `spaceKey`；`list_maps({spaceKey})` 列出该空间地图。
- `create_map({map,id?,spaceKey?,requestId?})`：创建私有地图；提供空间 key 时复用该空间。不提供时分配新空间并交付凭证。可靠重试应先取得并保存 spaceKey，再复用 requestId；省略 id 时有 requestId 却没有 spaceKey 会返回 400。
- `get_map({id,since?,view?,spaceKey?,previewToken?,editKey?})`：先验证访问权限，再返回默认摘要。最多 100 个地点、40 个事件；大字段截短并提示 `view=full`，`moreEvents` 时继续 `nextSince`。相同版本只返回无变化；完整几何通过 UI 专用 `_meta` 提供。不传 `since` 时窗口是调用方自己上次写入之后，按作者分别记录——协作者的 Agent 写入不会推掉你的未读窗口。
- `patch_map({id,spaceKey,baseVersion,operations,requestId?})`：Agent 局部更新，旧图可使用原 `editKey`。
- `submit_changes({id,spaceKey?,previewToken?,editKey?,baseVersion?,currentVersion?,intents?,userMessage?,requestId?})`：有写权限时记录本轮意图与草稿交接，只读调用仅生成摘要；返回继续规划消息，不启动 Agent。
- `share_map({id,spaceKey,canWrite?,revoke?,list?,revokeId?})`：生成单图 `previewToken` / `previewUrl`。`canWrite:true` 签发可编辑分享，持有者可以改这一张地图，但不能删除、再分享或认领空间；省略为只读。`list:true` 列出现有分享（`id`、生成时间、`canWrite`，没有令牌），`revokeId` 停用其中一条，`revoke:true` 停用该图全部分享（两种一起）。
- `copy_map({id,spaceKey?,previewToken?,editKey?,targetSpaceKey?,title?,requestId?})`：凭源图读取授权复制到目标空间。匿名客户端先取得并保存目标 key，再固定 `targetSpaceKey` 和 `requestId` 重试；无目标空间却要求 requestId 去重会返回 400。
- `delete_map({id,spaceKey?,editKey?})`：所有者专用，不可撤销地删除地图、全部历史版本、全部分享链接与基于分享的收藏。请先与用户确认。
- `subscribe_map({id,spaceKey?,previewToken?,editKey?})`：验证权限并说明 WS 订阅协议。

### Cartula Skill 与 MCP 指南

服务端把同一份标准 [SKILL.md](skills/cartula/SKILL.md) 同时作为 MCP 能力提供：`initialize.instructions` 取自其中的核心约定；支持 Resources 的宿主可读取 `cartula://skills/cartula/SKILL.md`，按内容哈希列出的版本 URI 可用于缓存校验；支持 Prompts 的宿主可选择 `cartula_guide`。只把工具交给模型的宿主调用只读工具 `get_guide({section?})`，省略 `section` 返回完整指南，`essentials`、`quickstart`、`collaboration`、`routing`、`days`、`editing`、`errors`、`delivery` 可按节读取。是否把 instructions、资源或提示模板交给模型由宿主决定，MCP 不会因为资源名为 `SKILL.md` 就自动安装客户端 Skill。

需要在支持 Agent Skills 的平台单独安装时，下载 `/skills/cartula/SKILL.md` 或 `/skills/cartula.zip`；安装 Skill 后仍需配置 `/mcp`。指南特别要求多 Agent 在同一地图用不同图层协作、跨天路线填写 `day` 并保留自动配色，以及道路规划默认只提供停靠点并让 Cartula 自动解算道路，不能把点位直接连成直线交付。

### Agent Plugin（Skill + MCP 的分发包）

如果宿主支持 [Agent Plugins 1.0.0](https://agent-plugins.org/specification)，并实现 Agent Skills 和 Streamable HTTP MCP 两种组件，可以安装同一个包，同时得到本地 Skill 和 Cartula MCP 配置。标准插件的本体是一个**本地目录**，目录根部必须有 `plugin.json`；Skill 固定放在 `skills/<name>/SKILL.md`，MCP 配置固定放在根部 `mcp.json`。标准没有规定“通过某个 HTTP 端口挂载一个远程插件目录”，也没有规定插件市场、下载器或自动更新服务。

Cartula 提供 ZIP 作为目录的便利传输格式，不能把 ZIP 或下面的 HTTP 索引当成 Agent Plugins 标准的一部分：

- `GET /plugins/cartula.zip`：当前包的 ZIP 下载，解压后使用里面含 `plugin.json` 的 `cartula/` 目录作为插件根目录。宿主是否支持直接导入 ZIP 由宿主决定；不支持时手动解压、导入该目录即可。
- `GET /plugins/cartula/latest.json`：Cartula 自定义的版本、下载地址、大小、SHA-256、Skill 哈希和 MCP 地址索引，便于自建安装器或发布脚本轮询。它不是通用宿主必须读取的更新协议。
- `GET /plugins/cartula-<version>-<sha256>.zip`：当前部署提供的内容寻址包，适合缓存和校验；升级后旧包地址返回 404，不会返回其他内容。需要长期下载或回滚时，把打包命令导出的各版 ZIP 保存在 Release 或对象存储中。

本地发布目录、ZIP 和校验文件：

```bash
npm run package:plugin -- \
  --public-url https://cartula.solutionsuite.cn \
  --out artifacts/plugins
```

命令会生成一个可直接检查的插件目录、ZIP、`.sha256` 和版本目录内的 `index.json`。生产包的 `mcp.json` 写入打包时指定的生产 URL（例如 `https://cartula.solutionsuite.cn/mcp`），没有变量占位符或 API Key；账号或空间密钥仍在宿主的 MCP 凭据管理中配置。服务端下载包使用部署的 `PUBLIC_URL`。MCP URL 仍可像以前一样直接配置，插件只是把 Skill 与该配置一起交付，不需要另开豆包专属端口。

版本和更新由宿主负责：Agent Plugins 只规定 `plugin.json.version` 的含义，宿主**可以**用它比较版本和缓存新鲜度，但标准没有要求宿主轮询 URL、下载 ZIP 或自动替换本地目录。MCP 也没有“服务端推送新插件”的机制；Cartula 当前是无状态 Streamable HTTP，`initialize` 会返回服务版本，`tools/list` 返回当前工具，且不声明 `listChanged` 通知。服务端部署后，宿主重连或重新执行 `tools/list` 即可看到工具变化；本地 Skill 要更新则必须由宿主重新安装插件。`latest.json` 只服务于自建更新器，不能让普通 MCP 或 Agent Plugin 宿主自动升级。

`get_map_state`、`edit_map`、`replace_map` 为 UI 专用。模型看到的工具 schema 只用各家宿主都接受的最小子集（type / properties / required / enum / items / 上下限 / description），不含 `pattern`、`oneOf` / `anyOf`、`const`、`exclusiveMinimum`、`propertyNames` 或元组，坐标是普通数字数组；所有约束仍由核心 schema 在调用落地时严格校验，错误带字段路径（`src/server/tool-schema.ts`，`tests/host-compat.test.ts` 守住这个子集）。宿主把嵌套参数（`map`、`operations`、`intents`）当作 JSON 字符串发来、或把数字和布尔写成字符串时，服务端先解开再校验；不是对应形状的字符串照常按字段名拒绝。每次 `tools/call` 在服务日志里留一行 `mcp`：宿主 User-Agent、工具名、被解开的参数名和结果（ok / 业务错误的状态码 / SDK 拒绝的错误码），`initialize` 记下 `clientInfo`；参数本身不记录。旧宿主需刷新工具列表或重连（豆包请删除后重新添加）；若仍只显示部分工具，还需检查宿主的工具权限／过滤设置，不能从服务端注册成功推断所有宿主均已可见。

交接使用两个版本字段：`baseVersion` 是本轮变更的读取起点，`currentVersion` 是本次提交所依据的地图版本。意图会覆盖同一作用域的既有意图，因此携带 `intents` 时应同时传 `currentVersion`；过期的首次提交返回 409 且不写入。收到明确冲突后先重读，再用新 `requestId` 和新版本发起一次提交；网络结果未知时保留原请求 ID、版本与载荷重试。服务端先去重再检查写入版本，成功请求的重放不产生新版本，也不覆盖后来的修改，返回数据可以是最新地图。仅追加草稿提交、无 `intents` 时版本差异只作提示；省略 `currentVersion` 保留旧调用方的无校验行为，超前版本返回 400。非空 `changes` 会被明确拒绝，实际编辑请使用 `patch_map` / `edit_map`。REST `POST /api/maps/{id}/submit` 使用相同规则。

UI resource `ui://cartula/map.html`，MIME `text/html;profile=mcp-app`；标准 `_meta.ui.resourceUri`、resource CSP 与 `openai/*` 兼容字段均声明。编辑器通过官方 ext-apps `App` bridge 完成握手、接收 tool result、调用工具并 `updateModelContext`，不依赖 cookie/localStorage/父 DOM。账号登录通过宿主打开独立页面，iframe 不收集密码。地图工具返回文本及相应页面入口，无 UI 宿主也可使用。

桌面内嵌画布的初始目标为 1280×720 CSS px，未约束的轴按该目标申请。固定轴由宿主控制；弹性轴使用 `maxHeight/maxWidth` 允许的空间，小于 320px 时进入紧凑布局而不突破宿主上限。尺寸只使用标准 `containerDimensions` 与 `ui/notifications/size-changed`，不发送任何宿主私有尺寸字段。去重按宿主实际收到的尺寸计算：发送失败不计入声明，同一尺寸可以再次发送并自动重试一次，成功之后重复的数值不再发送，避免协商变成 resize 循环。全屏根据实际响应更新，失败时给出反馈与独立页面入口。模拟宿主回归不能代替真实宿主尺寸和对话闭环验收。

保存通过 `updateModelContext` 通知版本，不请求自动重新规划。有尚未交接的修改时，保存状态旁出现带条数的「交给 Agent · N 条」入口，与菜单里的「按这些修改继续规划」是同一条提交链；交接成功后入口消失。用户可填写本轮意图（记录用户事件），通过标准 `ui/message` 提交本轮修改。经由分享链接（previewToken）进入的一方提交时，这条消息会带上这张地图自己的 previewToken，好让对方粘贴给自己的 Agent 也能直接调用 get_map，可编辑分享再带上 patch_map 提示，只读分享则改为提示 copy_map；所有者的消息里始终不出现任何凭证。

界面分别显示已保存、宿主已接收、明确拒绝和结果未知。宿主用 JSON-RPC 实现自定义错误码（-32000…-32099）说明拒绝时按拒绝展示并给出宿主原因；`-32601` 记为不支持，参数与权限类错误记为拒绝；超时、连接断开仍是结果未知，不自动重发，用户确认原对话后才可重发。独立网页或不支持消息的宿主提供复制入口。

已交接边界保存在服务端（`maps.handoff_version`，旧库自动补列并从 0 开始），刷新或重新打开不会退回 0 重复旧变更。视图确认送达后通过 UI 专用工具 `record_handoff` 或 `POST /api/maps/{id}/handoff` 回报；需要写权限，只前进，不得超过当前版本，不产生版本或事件。沙箱 iframe 的 origin 是 opaque、本地存储全部不可用，这时服务端记录是唯一能读回边界的地方；本端 `localStorage` / `sessionStorage` 只作辅助，覆盖“刚确认送达、回报还没落库”的一小段。`submit_changes` 记录的 `draft.commit` 只代表提交过，其后的 Agent 版本也不证明消息送达，因此都不用来推断边界——未确认的一轮会再次出现在待交接列表，宁可重复也不丢未处理的用户修改。读取同时返回 `handoffVersion`（最近交给对话）与 `agentVersion`（Agent 最后写入，也是不传 `since` 时的默认增量起点），两个边界不合并。`updateModelContext` 和 `ui/message` 都不证明 Agent 已开始处理，`subscribe_map` 也不会唤醒 Agent。

### 卡片尺寸与资源地址

> 排查宿主嵌入问题前先读 [docs/host-embedding.md](docs/host-embedding.md)：踩过的坑（CSS 封顶的三种错误写法、SDK 的 union 剥字段、宿主按 URI 缓存资源）、各宿主实测行为、以及本地模拟宿主和诊断读数怎么用。

`PREFERRED_WIDTH` / `PREFERRED_HEIGHT`（1280×720，`src/web/adapters/host-size.ts`）既是目标也是上限。每个轴取 `min(目标, 宿主声明的每一个界)`，`width`/`height`（固定）和 `maxWidth`/`maxHeight`（弹性）一视同仁都当上限：宿主声明的是它有多少地方，不是这张卡该占多少。渲染小于宿主固定值时仍然上报，好让宿主把余下的空间收回去。同一个数字在 CSS 里是 `--app-height`（`styles.css`），挂在 bootstrap 同步写入的 `data-embedded` 上，因此不依赖握手是否成功、也不依赖宿主发了什么 `displayMode`。

已知宿主行为（2026-09-09 实测，来自 `CARTULA_DIAGNOSTICS=1` 的读数，不是从文档推断）：

- **Claude Desktop 1.49585.0**：发 `containerDimensions: {maxHeight: 5000, width: <卡片宽>}` —— 弹性上限约六屏，宽度固定。guest SDK（`app.asar` → `/.vite/build/index.chunk-BiV0jkNg.js`，MCP Apps protocolVersion `2025-11-21`）的 `setupAutoResize` 量的是 `document.body.getBoundingClientRect().height`。宿主确实响应 `ui/notifications/size-changed`（它自家内置组件唯一的定高手段就是这个）。**并且它按 `_meta.ui.resourceUri` 缓存资源，跨会话存活。**
- **Codex**：初始 240 / 下限 200 / 上限 720，并把 `containerDimensions.maxHeight` 设成当前 `element.clientHeight` 回灌，所以框一旦小就会自锁。

App 资源因此发布在带构建号的地址 `ui://cartula/map.<release>.html`（`resources/list` 中的 App 只列当前版本，另列 Skill 资源）。旧地址 `ui://cartula/map.html` 和**任何历史版本 App 地址**都继续解析并返回当前构建 —— 宿主缓存了旧 `resourceUri` 时得到的是当前页面，而不是“资源不存在”。这依赖部署设置 `CARTULA_BUILD`；不设的话同一版本的所有构建共用一个地址，等于没有版本化。Skill 使用内容哈希 URI；未知历史哈希返回资源不存在，可重新列举或读取稳定入口取得当前正文。

服务端不宣告 `listChanged`：`/mcp` 是无状态的（每个 POST 新建 server、无 session id、`GET /mcp` 返回 405），发不出任何通知，宣告了也兑现不了，反而会让客户端以为可以一直缓存列表。

`CARTULA_DIAGNOSTICS=1` 在卡片上显示尺寸协商读数（宿主原样的 `containerDimensions`、申请了什么、算出多少、`body` 与 `documentElement` 实测值）。默认关闭，排查宿主问题时临时打开。

## 离线导出

页面选择导出 HTML，或携带读取凭证下载 `GET /m/{id}/export.html`。浏览器通过带授权头的 fetch 获取文件。单文件内联地图数据、JS 和样式，不含空间 key、会话或分享凭证。断网双击打开，可编辑和导出 JSON，再把 JSON 交给 Agent 导入。

离线包不包含预抓的 OSM 街道瓦片，使用无网络底图/坐标视图；路线和用户图层完整保留。WebGL/worker 被沙箱拦截时使用 SVG 视图降级。默认使用 OpenFreeMap Liberty 彩色底图，页面可切换简洁／深色风格以及中文／英文／当地地名。中文优先 `name:zh`，缺失时回退当地名称；不翻译用户地点名。地点标签按屏幕空间避让，缩小时降低密度，选中／悬停优先显示。署名为 OpenFreeMap / OpenMapTiles / OpenStreetMap。需要代理时设置 `TILE_PROXY_URL`，不要把代理地址写进仓库。`BASEMAP_STYLE` 可选 positron/liberty/bright/dark，可用 `TILE_URL` 配置其他栅格底图（栅格不支持切换地名语言）。署名需与所用底图匹配。

## 部署和维护

- `start.sh` / `stop.sh` 只操作 Cartula。同一鉴权模型内回退时，改 `.env` 中 `CARTULA_TAG` 后 `docker compose up -d`，保留 `data/`；0.3 到旧公开读取版本的回退见下方迁移限制。
- 备份用 SQLite 的 `VACUUM INTO` 生成一致快照，例如 `sqlite3 data/cartula.sqlite "VACUUM INTO 'backups/cartula-$(date +%F).sqlite'"`；容器运行时可用 `docker exec cartula node -e` 执行同等语句。只复制活跃数据库会漏掉 WAL。
- 升级 0.3 前先备份。旧地图保留公开链接与原来的每图 `editKey`，版本内容和去重记录原样保留；持旧 key 的用户认领后转为私有，原 key 继续只授权原图。新创建地图一律私有，重启不会将新图变成旧公开图。
- 账号会话使用 30 天 HttpOnly cookie，HTTPS 下带 Secure，SameSite=Lax；cookie 参与的变更请求携带 `X-Cartula-Request: 1`。密码用带独立盐的异步 scrypt 保存，认证接口单独限速。数据库迁移后回退旧程序不能理解新权限模型，应使用兼容权限模型的镜像，或先停服处理升级后的数据，不能直接用旧公开读取逻辑对外服务。
- 匿名地图默认持久保留，不自动删除；默认最多 1000 张地图、每张 1000 个版本，数据库约 512 MiB 达到写入上限后返回 507；单次载荷 2 MiB，图层/坐标也有上限。试用数据需定期备份，扩容/留存策略在对外服务前确定。
- Kubernetes 上使用 SQLite 时必须单副本、Recreate 策略和 ReadWriteOnce 卷。需要多副本时先换共享数据库并实现跨进程通知，不能直接扩 replicas。

`PUBLIC_URL` 必须是访问者可达的地址；`ALLOWED_ORIGINS` 为逗号分隔的浏览器 origin 白名单。`TILE_PROXY_URL` 和 `OSRM_PROXY_URL` 只放在部署环境的 `.env` 里。

对外 beta 是 `https://cartula.dev.solutionsuite.cn`，生产是 `https://cartula.solutionsuite.cn`。镜像拉取策略如果是 `IfNotPresent`，每次发布要用新 tag，重推同名 tag 不会重新拉取。SQLite 未改为共享数据库前不得扩容副本数。

`CARTULA_BUILD` 可选，填 commit sha 或 CI 构建号（`[A-Za-z0-9._-]`，最长 40 位，不合法则视为未设置）。设置后服务与它渲染的 App 共同声明 `0.4.0+<build>`：MCP `initialize` 的 `serverInfo`、App `ui/initialize` 声明的版本、`/healthz` 的 `release` 与 `openapi.json` 的 `info.version` 是同一个字符串，可据此定位某次会话对应的构建；两端不一致说明宿主里的页面早于当前部署。

## 验证与资料

```bash
npm run check
npm run test:e2e
```

API 描述 `/openapi.json`，Agent 总览 `/llms.txt`（开源声明、接入方式、凭据说明与核心约定；`/llms-full.txt` 附完整 Skill）。宿主嵌入的坑与验证做法见 [docs/host-embedding.md](docs/host-embedding.md)。

来源引用只是溯源信息，不替代数据许可。OSM 署名及公共瓦片使用政策、自托管地图数据许可、对外提供地图标注服务的要求需分别评估。技术设计不构成法律判断。

用户在工作台导入或替换整张地图时，也会记录为用户事件，Agent 的读取游标不会被推进。MCP 对应的 `replace_map` 与 `edit_map` 一样仅向 App 暴露。图层 ID 在地图内唯一；地点 ID 只需在所属图层内唯一，因此两条路线可以共用 `harbin` 这样的地点 ID。
