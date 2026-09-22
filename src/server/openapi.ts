import { z } from 'zod';
import { MapInputSchema, EditOperationSchema, IntentSchema } from '../core/schema.js';
import { RELEASE } from './release.js';
export function openApiDocument(publicUrl: string) {
  const example = {
    title: '大小兴安岭路线',
    layers: [{
      name: '小兴安岭 6 天',
      routing: {
        source: '示例路由数据（非实时路况）',
        profile: 'driving',
        legs: [
          { fromPointId: 'harbin', toPointId: 'yichun', distanceKm: 325, durationMinutes: 245, profile: 'driving' },
          { fromPointId: 'yichun', toPointId: 'heihe', distanceKm: 480, durationMinutes: 360 },
        ],
      },
      points: [
        { id: 'harbin', name: '哈尔滨', at: [126.642, 45.757], day: 1 },
        { id: 'yichun', name: '伊春', at: [128.899, 47.725], day: 2 },
        { id: 'heihe', name: '黑河', at: [127.499, 50.25], day: 6 },
      ],
    }],
  };
  const accessSchema = {
    type: 'object', description: '调用方对这张地图的权限；不写进版本数据。shared-edit 是可编辑分享：只能改这一张地图，不能删除、再分享或认领空间。preview、shared-edit 与 legacy-public 不返回 spaceId / spaceMapCount。',
    properties: {
      kind: { type: 'string', enum: ['owner', 'shared-edit', 'preview', 'legacy-public'] },
      editable: { type: 'boolean' }, canShare: { type: 'boolean' }, canClaim: { type: 'boolean' }, claimed: { type: 'boolean' },
      spaceId: { type: 'string' }, spaceMapCount: { type: 'integer' },
      authorId: { type: 'string', description: '调用方在事件里的作者标识（非凭据）。与 SemanticEvent.author 比较即可分辨哪些版本不是自己写的。' },
    },
    required: ['kind', 'editable', 'canShare', 'canClaim', 'claimed'],
  };
  const browserHeader = { in: 'header', name: 'X-Cartula-Request', required: true, schema: { type: 'string', enum: ['1'] }, description: '带会话 cookie 的变更必须发送；命令行改用 Authorization: Bearer。' };
  return {
    openapi: '3.1.0', info: {
      title: 'Cartula API', version: RELEASE,
      description: [
        '写、读、订阅。地图默认私有：地图 ID 或页面 URL 本身不授予读取权限。',
        'Bearer 接受空间密钥 spaceKey（授权该空间的全部地图）、账号 API Key（POST /api/me/api-keys，授权该账号已认领的全部空间）、只读分享令牌 previewToken（只授权该图只读）、以及接入空间模型之前创建的地图自己的 editKey（只授权该地图）。服务端按数据库摘要判定权限，不看前缀。',
        '账号会话 cookie 是另一种主体：它授权该账号已认领的空间，以及仍然有效的收藏。带 cookie 的变更必须同时发送 X-Cartula-Request: 1。MCP 客户端把 API Key 放在 Authorization 请求头，不使用 cookie。',
        '凭证错误一律拒绝，不会降级为公开访问。服务端只保存凭证摘要，密钥仅在创建时返回一次。',
      ].join(''),
    }, servers: [{ url: publicUrl }],
    paths: {
      '/api/spaces': {
        post: { operationId: 'createSpace', summary: '申请空间密钥', description: '返回 {spaceId, spaceKey, claimed}。带会话 cookie 时空间直接归该账号（需要 X-Cartula-Request: 1）。spaceKey 只在这次响应里出现。', security: [{}, { session: [] }], parameters: [{ ...browserHeader, required: false }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } }, responses: { '200': { description: 'SpaceCredential' }, '507': { description: '容量限制' } } },
      },
      '/api/session': {
        get: { operationId: 'getSession', summary: '当前会话', security: [{}, { session: [] }], responses: { '200': { description: '{user: {id,email} | null}' } } },
      },
      '/api/me/api-keys': {
        get: { operationId: 'listApiKeys', summary: '列出账号 API Key', description: '只返回 id、名称、hint 与创建时间，不返回密钥本身。需要登录 cookie。', security: [{ session: [] }], responses: { '200': { description: '{keys: ApiKeyInfo[]}' }, '401': { description: '未登录' } } },
        post: { operationId: 'createApiKey', summary: '创建账号 API Key', description: '返回 {id,name,hint,createdAt,apiKey}。apiKey 只在这次响应里出现，之后无法找回。每个账号最多 10 把。用于 MCP 客户端的 Authorization: Bearer。需要登录 cookie 与 X-Cartula-Request: 1。', security: [{ session: [] }], parameters: [browserHeader], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 80 } } } } } }, responses: { '200': { description: 'CreatedApiKey' }, '401': { description: '未登录' }, '429': { description: '数量达上限' } } },
      },
      '/api/me/api-keys/{id}': {
        delete: { operationId: 'revokeApiKey', summary: '停用一把账号 API Key', description: '停用后立即失效。需要登录 cookie 与 X-Cartula-Request: 1。', security: [{ session: [] }], parameters: [browserHeader, { in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ok:true}' }, '401': { description: '未登录' }, '404': { description: '不存在或已停用' } } },
      },
      '/api/auth/register': {
        post: { operationId: 'register', summary: '注册账号', description: '邮箱 trim + 小写，最多 254 字符；密码 12–128 字符且同时包含大小写字母、数字与符号，passwordConfirm 必须一致。没有邮件、验证状态或找回入口。成功后建立 30 天 HttpOnly 会话 cookie。', parameters: [browserHeader], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['email', 'password', 'passwordConfirm'], properties: { email: { type: 'string', maxLength: 320 }, password: { type: 'string', minLength: 12, maxLength: 128 }, passwordConfirm: { type: 'string' } } } } } }, responses: { '200': { description: 'AccountSession' }, '400': { description: '邮箱格式、密码强度或两次输入不一致' }, '403': { description: '缺少 X-Cartula-Request 或跨站请求' }, '409': { description: '该邮箱已注册' } } },
      },
      '/api/auth/login': {
        post: { operationId: 'login', summary: '登录', description: '失败统一返回 401 与同一条文案，不区分邮箱是否存在；认证接口单独限速并限制并发密码计算。', parameters: [browserHeader], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { '200': { description: 'AccountSession' }, '401': { description: '邮箱或密码不正确' }, '503': { description: '并发密码校验过多，请稍后重试' } } },
      },
      '/api/auth/logout': {
        post: { operationId: 'logout', summary: '注销', description: '在服务端撤销会话并清除 cookie；此后该 cookie 不再授权任何地图，包括仍在连接的 WebSocket。', security: [{ session: [] }], parameters: [browserHeader], responses: { '200': { description: '{ok:true}' } } },
      },
      '/api/maps': {
        get: { operationId: 'listMaps', summary: '空间或账号的地图与收藏', description: '用 spaceKey 时返回该空间的地图；登录时返回账号名下所有空间的地图加收藏。收藏的 available=false 表示分享已被撤销。', security: [{ bearer: [] }, { session: [] }], responses: { '200': { description: 'MapLibrary：{maps: LibraryMap[], favorites: FavoriteMap[]}' }, '403': { description: '既没有空间密钥也没有登录' } } },
      },
      '/api/maps/{id}': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        delete: { operationId: 'deleteMap', summary: '删除地图', description: '所有者专用，不可撤销：地图、全部历史版本、全部分享链接，以及基于这些分享的收藏一并删除，正在订阅的 WebSocket 会被关闭。cookie 调用需要 X-Cartula-Request: 1。', security: [{ bearer: [] }, { session: [] }], parameters: [browserHeader], responses: { '200': { description: '{ok:true, id, title}' }, '403': { description: '不是所有者' }, '404': { description: '地图不存在' } } },
      },
      '/api/maps/{id}/access': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        post: { operationId: 'mapAccess', summary: '查询自己对这张地图的权限', description: '只读调用方也可以问；凭证错误仍然拒绝。', security: [{ bearer: [] }, { session: [] }], responses: { '200': { description: '{id, version, ...MapAccess}' }, '403': { description: '无权限或凭证无效' }, '404': { description: '地图不存在' } } },
      },
      '/api/maps/{id}/claim': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        post: { operationId: 'claimMap', summary: '把这张地图所在的整个空间保存到账号', description: '需要登录 cookie 加 owner Bearer。认领是原子的单所有者操作：同一账号重试成功，已归其他账号返回 409。空间密钥不会失效，Agent 可继续使用。旧的 legacy-public 地图凭其原 editKey 认领后转为新的私有空间，原 editKey 此后仍只授权该地图。', security: [{ bearer: [], session: [] }], parameters: [browserHeader], responses: { '200': { description: 'ClaimResult：{access, claimedMapCount}' }, '401': { description: '未登录' }, '403': { description: '不是所有者' }, '409': { description: '已归属其他账号' } } },
      },
      '/api/maps/{id}/preview': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        get: { operationId: 'listPreviews', summary: '列出该地图仍有效的分享', description: '所有者专用。只返回 id、生成时间和读写权限：令牌明文只在生成时返回一次，服务端只留摘要，事后取不回来。', security: [{ bearer: [] }, { session: [] }], responses: { '200': { description: '{links: ShareLinkInfo[]}，每条 {id, createdAt, canWrite}，新的在前' }, '403': { description: '不是所有者' } } },
        post: { operationId: 'createPreview', summary: '生成分享链接', description: '所有者专用。每次调用生成一条独立 previewToken，旧链接不会自动失效。请求体 {canWrite?:boolean}：省略或 false 生成只读分享（可读、导出、订阅、收藏、复制）；true 生成可编辑分享，持有者可以修改这一张地图，但仍不能删除它、再生成分享、认领空间或读取空间密钥。两种分享都由 DELETE 一次撤销。', security: [{ bearer: [] }, { session: [] }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { canWrite: { type: 'boolean', description: 'true 时签发可编辑分享；省略为只读。' } } } } } }, responses: { '200': { description: 'PreviewLink：{id, createdAt, canWrite, previewToken, previewUrl}' }, '403': { description: '不是所有者' }, '429': { description: '该地图分享链接过多' } } },
        delete: { operationId: 'revokePreviews', summary: '停用该地图的全部分享', description: '撤销后基于这些分享的收藏立即失去读取权限，正在订阅的 WebSocket 也会被关闭。', security: [{ bearer: [] }, { session: [] }], responses: { '200': { description: '{ok:true}' }, '403': { description: '不是所有者' } } },
      },
      '/api/maps/{id}/preview/{linkId}': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }, { in: 'path', name: 'linkId', required: true, schema: { type: 'string' }, description: 'GET /api/maps/{id}/preview 返回的分享 id。' }],
        delete: { operationId: 'revokePreview', summary: '停用其中一条分享', description: '所有者专用。只撤销这一条，同一张地图的其他分享继续有效。', security: [{ bearer: [] }, { session: [] }], responses: { '200': { description: '{ok:true}' }, '403': { description: '不是所有者' }, '404': { description: '这条分享不存在或已停用' } } },
      },
      '/api/me/favorites/{id}': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        put: { operationId: 'addFavorite', summary: '收藏一张分享给我的地图', description: '需要登录 cookie 加该图的 previewToken；空间密钥不是分享授权，会被拒绝。幂等。', security: [{ bearer: [], session: [] }], parameters: [browserHeader], responses: { '200': { description: '{ok:true}' }, '401': { description: '未登录' }, '403': { description: '没有有效的分享令牌' } } },
        delete: { operationId: 'removeFavorite', summary: '移除收藏', description: '分享已被撤销时同样可以移除。', security: [{ session: [] }], parameters: [browserHeader], responses: { '200': { description: '{ok:true}' }, '401': { description: '未登录' } } },
      },
      '/api/maps/{id}/copy': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        post: {
          operationId: 'copyMap', summary: '复制成新的独立地图',
          description: '需要源地图的读取权限。副本只带标题、图层与意图，不复制历史、归属、密钥或分享授权。目标由 targetSpaceKey 指定，未指定时归当前账号，都没有则新建空间并返回一次空间凭证。requestId 只在同一个已确定的目标空间内去重；未指定 targetSpaceKey 且未登录时每次调用都会新建空间与副本，需要幂等请先 POST /api/spaces。',
          security: [{ bearer: [] }, { session: [] }],
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: { targetSpaceKey: { type: 'string' }, title: { type: 'string', maxLength: 120 }, requestId: { type: 'string', maxLength: 128 } } } } } },
          responses: { '200': { description: '新地图写响应 + access，必要时带 spaceId/spaceKey' }, '403': { description: '无法读取源地图，或目标空间密钥无效' } },
        },
      },
      '/m/{id}': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$' } }],
        put: { operationId: 'putMap', summary: '一次创建或更新所有图层', description: '创建时不带 Bearer 会新建匿名空间，并仅此一次返回 spaceKey（同时兼容 editKey 与 editUrl=#space=…）；带 spaceKey 则创建在该空间，带会话 cookie 则创建在账号默认空间。Bearer 无效一律 403，不能自带新密钥创建。更新必须具备写权限。相同载荷去重；显式新的 Idempotency-Key 可重新应用旧内容。', security: [{}, { bearer: [] }, { session: [] }], parameters: [{ in: 'header', name: 'If-Match', schema: { type: 'string' }, description: '可选 ETag 冲突检测，例如 "2"' }, { in: 'header', name: 'Idempotency-Key', schema: { type: 'string', maxLength: 128 } }], requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(MapInputSchema, { io: 'input' }), example } } }, responses: { '200': { description: '最新地图，version, url, changes, access；新建空间还返回 spaceId / spaceKey / editKey 与 editUrl' }, '400': { description: '输入有误，返回可操作的 hint' }, '403': { description: '凭证缺失、无效或只读' }, '409': { description: '版本或幂等键冲突' }, '507': { description: '容量限制' } } },
        patch: { operationId: 'patchMap', summary: 'Agent 局部更新，保留其余用户改动', security: [{ bearer: [] }, { session: [] }], requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(z.object({ baseVersion: z.number().int().positive(), operations: z.array(EditOperationSchema).min(1).max(100), requestId: z.string().max(128).optional() }), { io: 'input' }) } } }, responses: { '200': { description: '摘要，原子版本与 actor=agent 的语义记录；requestId 支持重试' }, '403': { description: '需要写权限（空间密钥、账号或旧 editKey）' }, '409': { description: '版本不匹配，重新读取并合并' } } },
        get: { operationId: 'getMap', summary: '读取最新图层和用户改动', security: [{ bearer: [] }, { session: [] }], parameters: [{ in: 'query', name: 'view', schema: { type: 'string', enum: ['full', 'summary', 'changes', 'affected'], default: 'full' }, description: 'HTTP 默认保持 full 兼容；Agent 建议 summary（无几何）、affected（since 之后受影响的图层/地点）或 changes（只含事件），MCP 默认 summary。' }, { in: 'query', name: 'since', schema: { type: 'integer', minimum: 0 }, description: '可选版本游标，返回此版本之后的事件（不论出自用户还是 Agent）；省略时窗口是最近一次 Agent 写入之后，响应的 sinceVersion 会说明实际窗口。' }, { in: 'query', name: 'includeGeometry', schema: { type: 'boolean' }, description: '摘要中是否保留 path/geojson。' }, { in: 'query', name: 'includeHistory', schema: { type: 'boolean', default: true }, description: '是否返回 events。' }], responses: { '200': { description: 'MapSnapshot 或摘要：图层、changes、events、version、intents、access，以及增量标志 sinceVersion / changed（相对 sinceVersion 是否有任何作者的改动）/ unchanged（changed 的反义）/ hasUserChanges / hasAgentChanges；四种 view 的这组标志一致。权限在读取任何内容之前校验。ETag 响应头' }, '403': { description: '没有这张地图的访问权限' }, '404': { description: '地图不存在' } }, 'x-websocket': { url: `${publicUrl.replace(/^http/, 'ws')}/m/{id}`, subscribe: { type: 'edit', changes: ['在「黑河」之后插入了「五大连池」'], version: 2 }, suggest: { type: 'suggest', text: '建议分两天走', highlight: ['五大连池'] }, authentication: '私有地图必须先认证：Authorization: Bearer <spaceKey|previewToken> 或会话 cookie，或连接后发送 {type:"auth",key:"…"} / {type:"auth",previewToken:"…"}。10 秒内未认证会被关闭，此前不发送任何地图数据。每条通知都会重新校验会话、令牌与权限，撤销或注销后连接关闭。只读预览不能发送建议。' } },
      },
      '/api/maps/{id}/submit': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        post: {
          operationId: 'submitChanges',
          summary: '把本轮用户意图交给 Agent',
          description: [
            '记录本轮 intents 与一条草稿提交，返回交接消息与受影响摘要；不应用任何操作（传 changes 会被 400 拒绝），也不覆盖图层数据。',
            'intent 会覆盖同一 scope 已有的意图，因此带 intents 时必须传 currentVersion 作并发校验：地图已前进则返回 409 VERSION_CONFLICT 且不写入；只带 userMessage 时不覆盖任何内容，仅在响应里返回 staleView 与 changesSinceClientVersion。省略 currentVersion 不做校验。currentVersion 大于当前版本返回 400。',
            '同一 requestId 加同一 (userMessage, intents) 的重放先于版本校验被应答，因此“写入成功但响应丢失”后的重试只会产生一条 draft.commit；收到 409 后请重读地图，用新的 requestId 与新的 currentVersion 重新提交。',
          ].join(''),
          security: [{ bearer: [] }, { session: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(z.strictObject({
            baseVersion: z.number().int().nonnegative().optional(),
            currentVersion: z.number().int().positive().optional(),
            userMessage: z.string().max(2000).optional(),
            intents: z.array(IntentSchema).max(20).optional(),
            requestId: z.string().min(1).max(128).optional(),
          }), { io: 'input' }), example: { baseVersion: 2, currentVersion: 5, userMessage: '想少开车', intents: [{ scope: 'map', text: '每天开车不超过 5 小时', priority: 'must' }], requestId: 'submit-9f31' } } } },
          responses: {
            '200': { description: '交接消息 message、affected 摘要、version，以及 clientVersion / staleView / changesSinceClientVersion（传了 currentVersion 时）' },
            '400': { description: 'changes 不受支持、currentVersion 大于当前版本，或请求体含未知字段' },
            '403': { description: '没有这张地图的访问权限' },
            '409': { description: 'VERSION_CONFLICT：带 intents 且 currentVersion 落后，未写入；重读后用新的 requestId 重试' },
          },
        },
      },
      '/api/maps/{id}/handoff': {
        parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
        post: {
          operationId: 'recordHandoff',
          summary: '记录本轮修改确实已经交给对话',
          description: [
            '与 submit 分开：submit 记录草稿提交，送达与否只有界面知道（宿主接受了 ui/message，或用户复制了消息），确认之后才调用这里。',
            '只推进服务端的交接边界 handoff_version，不写版本、事件或改动记录，因此不与版本冲突、requestId 去重或原子性相互作用；边界只前进，重复提交同一版本安全。',
            'version 必须是这次交接消息所描述的版本，不能大于当前版本（否则 400 UNKNOWN_VERSION），否则会掩盖没人交接过的用户修改。需要写权限：只读分享令牌不能移动边界。',
            '读取时通过 handoffVersion 返回（与 Agent 写入游标 agentVersion 是两个不同的边界），供刷新或换设备重开后恢复增量起点。',
          ].join(''),
          security: [{ bearer: [] }, { session: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(z.strictObject({
            version: z.number().int().nonnegative(),
          }), { io: 'input' }), example: { version: 5 } } } },
          responses: {
            '200': { description: '{id, handoffVersion, agentVersion, version}：更新后的交接边界、Agent 写入游标和地图当前版本' },
            '400': { description: 'version 大于当前版本（UNKNOWN_VERSION），或请求体含未知字段' },
            '403': { description: '没有这张地图的写权限（只读分享不能记录交接）' },
            '404': { description: '地图不存在' },
          },
        },
      },
      '/m/{id}/export.html': { get: { operationId: 'exportOffline', summary: '下载可离线编辑的单文件地图', description: '需要该地图的读取权限。凭证只走 Authorization: Bearer 或会话 cookie，不接受查询参数，因此浏览器需要用 fetch + blob 下载而不是普通链接跳转。', security: [{ bearer: [] }, { session: [] }], parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { '200': { description: '不含编辑凭证的内联 HTML 文件' }, '403': { description: '没有这张地图的访问权限' } } } },
    }, components: {
      schemas: { MapAccess: accessSchema },
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'spaceKey、账号 API Key、previewToken 或旧地图自身的 editKey；服务端按数据库摘要判定权限。' },
        session: { type: 'apiKey', in: 'cookie', name: 'cartula_session', description: '登录后的 HttpOnly 会话 cookie；参与变更时必须同时发送 X-Cartula-Request: 1。' },
      },
    },
  };
}
