import type { FastifyInstance, FastifyRequest } from 'fastify';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { toolSchema } from './tool-schema.js';
import { mapSummaryText, presentMap, type ReadView } from './presentation.js';
import { MAP_URL_LABEL, MAP_URL_NOTE, planningMessage } from '../core/handoff.js';
import { EditOperationSchema, IntentSchema, MapInputSchema } from '../core/schema.js';
import { DomainError } from '../core/model.js';
import type { MapSnapshot, WriteResult } from '../core/types.js';
import type { MapAccess, ShareLinkInfo, SpaceCredential } from '../core/access.js';
import type { MapStore } from './store.js';
import { assertReachesMap, bearerOf, outOfScope, principalFromBearer, principalFromCredentials, requireOwner, requireRead, requireWrite, shareCredentialFor, type Principal } from './guard.js';
import { appHtml } from './html.js';
import { RELEASE, RELEASE_NAME } from './release.js';
import { resourceTag } from '../core/release.js';
import { GUIDE_INSTRUCTIONS, registerGuideMcp } from './guide.js';

/**
 * The App resource, named for the build that serves it.
 *
 * A `ui://` URI is an opaque identifier with no stability requirement, and
 * hosts are free to cache what they read from one. A fixed name plus a caching
 * host means a deploy can go completely unobserved: the server serves the new
 * HTML to anyone who asks, and the host never asks, because it already has
 * `ui://cartula/map.html`. That is indistinguishable from a fix that did not
 * work — two rounds of size fixes were verified live on the server and never
 * reached the card.
 *
 * So the name changes with the build. `resources/list` reports it, and every
 * tool that renders the App points at it, so nothing has to agree with a
 * constant written down somewhere else.
 */
export const RESOURCE_URI = `ui://cartula/map.${resourceTag(RELEASE)}.html`;
/**
 * What builds before this one published, still served.
 *
 * A host that kept a tool definition from an earlier session would otherwise
 * ask for a URI that no longer exists and render nothing at all — worse than
 * the stale copy this change is about. The alias answers with the current
 * build, so the worst case stays "one session behind" rather than "broken".
 */
export const LEGACY_RESOURCE_URI = 'ui://cartula/map.html';

/**
 * Whether this deployment shows the size-negotiation read-out on the card.
 *
 * A card inside a host we cannot attach a debugger to is otherwise opaque:
 * wrong height, no way to tell whether the host's numbers, the arithmetic or
 * the layout produced it. Opt-in per deployment (the beta ConfigMap sets it),
 * so it never reaches anyone who did not ask to be looking at it.
 */
const DIAGNOSTICS = process.env.CARTULA_DIAGNOSTICS === '1';

/** Credentials a tool call proved it holds, echoed back to that caller only. */
interface Held { spaceId?: string; spaceKey?: string; editKey?: string; previewToken?: string; legacy?: boolean }

/**
 * The live shares of one map, in the text a model actually reads.
 *
 * Hosts show the model `content`, not `structuredContent`, so the ids have to
 * be here — a list the model cannot name back is a list it cannot revoke from.
 * The tokens are not here because they are nowhere: only their digests were
 * kept, which is the sentence this prints instead of an offer to show them.
 */
function shareListText(links: readonly ShareLinkInfo[]): string {
  if (!links.length) return '这张地图目前没有有效的分享链接。';
  const rows = links.map(link => `- ${link.id} · ${link.canWrite ? '可编辑' : '只读'} · ${link.createdAt.slice(0, 10)} 生成`);
  return `这张地图有 ${links.length} 条有效分享（链接明文只在生成时返回一次，这里取不回来）：\n${rows.join('\n')}\n停用其中一条：share_map({id,spaceKey,revokeId:"<上面的 id>"})。`;
}

/** Top-level argument shapes a host has been seen to hand over as strings. */
type ArgumentKind = 'object' | 'array' | 'number' | 'boolean';

/**
 * Which top-level arguments of a tool are containers, numbers or booleans.
 *
 * Read off the tool's own zod shape as it is registered, so the unwrapping in
 * `registerMcp` cannot drift from what the tool actually accepts.
 */
function argumentKindsOf(inputSchema: unknown): Record<string, ArgumentKind> {
  const kinds: Record<string, ArgumentKind> = {};
  if (!inputSchema || typeof inputSchema !== 'object' || 'def' in inputSchema) return kinds;
  for (const [key, schema] of Object.entries(inputSchema as Record<string, unknown>)) {
    let def = (schema as { def?: { type?: string; innerType?: unknown } } | undefined)?.def;
    while (def && (def.type === 'optional' || def.type === 'nullable' || def.type === 'default')) def = (def.innerType as { def?: typeof def } | undefined)?.def;
    if (def?.type === 'object' || def?.type === 'array' || def?.type === 'number' || def?.type === 'boolean') kinds[key] = def.type;
  }
  return kinds;
}

/**
 * Some hosts hand a nested argument over as the JSON text of it, and a number
 * or a boolean as the string the model wrote. Unwrap exactly those before the
 * SDK validates, and nothing else: a string field is never parsed, and a
 * string that is not the JSON of the expected container is left as it is, so
 * the validation error still names the field. Returns the keys rewritten, for
 * the call log.
 */
export function normalizeArguments(args: unknown, kinds: Record<string, ArgumentKind>): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const rewritten: string[] = [];
  for (const [key, kind] of Object.entries(kinds)) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const text = value.trim();
    let replacement: unknown;
    if (kind === 'object' || kind === 'array') {
      if (!text.startsWith(kind === 'object' ? '{' : '[')) continue;
      try { replacement = JSON.parse(text); } catch { continue; }
      const isObject = !!replacement && typeof replacement === 'object' && !Array.isArray(replacement);
      if (kind === 'object' ? !isObject : !Array.isArray(replacement)) continue;
    } else if (kind === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(text)) continue;
      replacement = Number(text);
    } else {
      if (text !== 'true' && text !== 'false') continue;
      replacement = text === 'true';
    }
    record[key] = replacement;
    rewritten.push(key);
  }
  return rewritten;
}

export function createMcpServer(store: MapStore, tileUrl: string, tileAttribution = '© OpenStreetMap contributors', styleUrl?: string, httpPrincipal: Principal = {}) {
  // The same release string the App declares back through `ui/initialize`; see
  // `src/core/release.ts`.
  const server = new McpServer({ name: RELEASE_NAME, version: RELEASE }, { instructions: GUIDE_INSTRUCTIONS });
  // Every tool is registered through here, so that one place knows, per tool,
  // which arguments are containers, numbers or booleans — what `registerMcp`
  // needs to unwrap the strings some hosts send in their place.
  const argumentKinds = new Map<string, Record<string, ArgumentKind>>();
  const registry: Pick<McpServer, 'registerTool'> = {
    registerTool: ((name, config, cb) => {
      argumentKinds.set(name, argumentKindsOf(config.inputSchema));
      return server.registerTool(name, config, cb);
    }) as McpServer['registerTool'],
  };
  const meta = { ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': RESOURCE_URI };
  const appMeta = { ui: { resourceUri: RESOURCE_URI, visibility: ['app'] } };
  /**
   * Turn the credentials named in tool arguments into a principal.
   *
   * Each one is verified on its own, against the database, *and* against the
   * map it was presented on: a caller that passes a valid key for another space
   * has named a credential that does not apply here, and that is refused rather
   * than absorbed. Merging them and letting the last one win would make the
   * argument order decide whether the mistake was noticed — and would let a
   * wrong key ride along on a right one. MCP never reads the browser's session
   * cookie, so an embedded App cannot borrow the page's account.
   */
  const principalFor = (mapId: string | undefined, args: { spaceKey?: string; editKey?: string; previewToken?: string }): Principal => {
    const principal: Principal = {
      scoped: httpPrincipal.scoped,
      accountKey: httpPrincipal.accountKey,
      account: httpPrincipal.account,
      space: httpPrincipal.space,
      preview: httpPrincipal.preview,
      legacy: httpPrincipal.legacy,
    };
    const adopt = (named: Principal) => {
      if (named.preview) {
        if (principal.preview && principal.preview.mapId !== named.preview.mapId) throw outOfScope();
        principal.preview = named.preview;
      }
      if (named.space) {
        if (principal.space && principal.space.id !== named.space.id) throw outOfScope();
        principal.space = named.space;
      }
      if (named.legacy) principal.legacy = named.legacy;
      if (named.scoped) principal.scoped = true;
    };
    if (args.previewToken) adopt(principalFromCredentials(store, { mapId, previewToken: args.previewToken }));
    for (const key of [args.spaceKey, args.editKey]) if (key) adopt(principalFromBearer(store, key, mapId));
    // Every named credential must reach this map. Checking here, before
    // `grantFor` looks for *a* proof, is what stops a correct key from
    // vouching for a wrong one presented beside it.
    if (mapId) assertReachesMap(store, mapId, principal);
    return principal;
  };
  /** What the caller may keep: only credentials it already holds, plus a key this call minted. */
  const heldBy = (principal: Principal, args: { spaceKey?: string; editKey?: string; previewToken?: string }, access: MapAccess, result?: WriteResult): Held =>
    // An editable share is editable *and* holds nothing but its share token.
    // Falling through to the owner branch would echo back a `spaceKey` field
    // built from arguments this caller never sent, and label a token that
    // opens one map as a key to the whole space.
    access.kind === 'shared-edit'
      ? { previewToken: args.previewToken }
      : access.editable
        ? {
          spaceId: result?.spaceId ?? access.spaceId,
          spaceKey: result?.spaceKey ?? args.spaceKey,
          editKey: result?.spaceKey ?? args.spaceKey ?? args.editKey,
          // A pre-space-model map is still reached through its own `#key=` link;
          // calling that key a space key would mislabel a link people already have.
          ...(principal.legacy && !result?.spaceKey && !args.spaceKey ? { legacy: true } : {}),
        }
        : { previewToken: args.previewToken };
  /**
   * The hidden channel the App initialises from: the whole snapshot, the
   * basemap settings, this caller's own credentials and what they allow. A
   * preview context carries the share token and nothing else — no space key,
   * no space id.
   */
  const appContext = (map: MapSnapshot, held: Held, access?: MapAccess) => ({
    // The tool *definition* already names the resource, which is where a host
    // is expected to look. Naming it on the result too costs one field and
    // covers a host that looks there instead — both spellings, since the SDK
    // writes both on the definition and it is not worth guessing which one a
    // given host reads.
    ui: { resourceUri: RESOURCE_URI },
    'ui/resourceUri': RESOURCE_URI,
    'openai/outputTemplate': RESOURCE_URI,
    cartula: {
      map, tileUrl, tileAttribution, styleUrl,
      ...(access ? { access } : {}),
      ...(held.editKey ? { editKey: held.editKey } : {}),
      ...(held.spaceKey ? { spaceKey: held.spaceKey } : {}),
      ...(held.spaceId ? { spaceId: held.spaceId } : {}),
      ...(held.previewToken ? { previewToken: held.previewToken } : {}),
    },
  });
  /**
   * One tool result: what the model sees, what the App sees, and the owner link.
   *
   * `link` is set by the write tools only. A read never puts a credential into
   * the model-visible payload — the App gets what it needs through `_meta`, and
   * a key that travels on every `get_map` is a key in every transcript.
   */
  const success = (map: WriteResult, held: Held, access?: MapAccess, options: { view?: ReadView; since?: number; appOnly?: boolean; link?: boolean; present?: { includeGeometry?: boolean; includeHistory?: boolean } } = {}) => {
    const { editKey: createdKey, editUrl: _editUrl, spaceKey: _spaceKey, spaceId: _spaceId, ...publicMap } = map;
    const { view = 'summary', since, appOnly = false, link = false, present } = options;
    const editUrl = link && held.editKey ? `${map.url}#${held.legacy ? 'key' : 'space'}=${encodeURIComponent(held.editKey)}` : undefined;
    const presented = appOnly ? undefined : presentMap(publicMap, view, since, present);
    const data = presented ?? { id: map.id, version: map.version };
    const summary = presented ? mapSummaryText(publicMap, presented, access?.authorId) : '';
    // The App renders the whole map and counts what is still un-handed-over, so
    // its hidden copy is the latest state with the complete event history. A
    // write answers against the caller's own `baseVersion`, which is the right
    // window for the model and far too narrow for the view: after two edits it
    // would show one, and the pending count would undercount the round. The
    // model-visible payload above is untouched.
    const hidden = appOnly ? store.get(map.id, 0) : publicMap;
    // The page URL is not a share: it grants nothing on its own and opens only
    // for a credential the reader already holds. Only `share_map` mints
    // something that may be called a read-only share — see `MAP_URL_LABEL`.
    const line = editUrl
      ? `编辑地图（请把此链接给用户）：${editUrl}\n这条链接带空间密钥，不要当作分享；需要只读分享链接时调用 share_map。`
      // Authorised by someone else's share. The token is not echoed: this
      // caller already passed it in, and a credential repeated on every read is
      // a credential in every transcript.
      : access?.kind === 'shared-edit'
        ? `${MAP_URL_LABEL}：${map.url}\n你持有的是可编辑分享链接：可以增删改图层、地点和路线，不能删除地图、再生成分享或认领空间。交给用户时用你手上那条 #preview= 链接。这张地图还有别的协作者，改动前先用 get_map 读一次增量。`
        : access?.editable
          ? held.editKey
            ? `${MAP_URL_LABEL}：${map.url}\n${MAP_URL_NOTE}把地图交给用户时用带 spaceKey 的编辑链接。`
            // Authorised, but by a header this call cannot put into a link. Said
            // where the decision is actually made: an Agent that reads "you may
            // omit spaceKey" in a tool description has no way to know it just
            // cost the user a working link, and by then the map exists.
            : `${MAP_URL_LABEL}：${map.url}\n本次没有可以交给用户的编辑链接——授权来自账号 API Key，地址本身不含凭据，只有登录同一账号的浏览器打得开。要给别人一条能直接打开的只读链接请调用 share_map；想让以后新建的地图自带编辑链接，先调用 create_space，再把返回的 spaceKey 传给 create_map。`
          : `地图地址（需要当前分享权限）：${map.url}\n这是只读访问：地址本身不含凭据，只有持有这条分享令牌的人打得开；不能编辑，也不能再分享。`;
    return {
      content: [{ type: 'text' as const, text: `${map.title} · v${map.version}${since === map.version ? ' · 无变化' : ''}\n${line}${summary ? `\n${summary}` : ''}` }],
      structuredContent: {
        ...data,
        ...(access ? { access } : {}),
        // A key travels in the model-visible payload only when this very call
        // created it; a caller's own key never comes back from a read.
        ...(createdKey ? { editKey: createdKey, spaceKey: createdKey, spaceId: map.spaceId } : {}),
        ...(editUrl ? { editUrl } : {}),
      },
      _meta: appContext(hidden, held, access),
    };
  };
  const failure = (error: unknown) => {
    if (error instanceof DomainError) {
      const details = (error.details && typeof error.details === 'object') ? error.details as Record<string, unknown> : undefined;
      const payload = {
        error: error.message,
        hint: error.hint,
        status: error.statusCode,
        ...(details ?? { details: error.details }),
        ...([400, 403, 409, 429].includes(error.statusCode)
          ? { guide: 'get_guide({"section":"errors"}) 可读取恢复流程；先按本次错误与 hint 处理。' } : {}),
      };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    }
    return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: '操作失败，请检查输入并重试。' }) }] };
  };

  const spaceKeyArg = z.string().min(1).max(512).optional();
  const previewTokenArg = z.string().min(1).max(512).optional();

  // Advertised as `additionalProperties: false`, so a field added to
  // `SpaceCredential` and not to this shape would be a schema that lies about
  // the payload. `satisfies` makes that a compile error rather than a client
  // that rejects a valid response.
  const spaceCredentialShape = {
    spaceId: z.string().describe('空间的公开标识。不是凭据，单独拿去鉴权会被拒绝。'),
    spaceKey: z.string().describe('空间的写入凭据，只在这次调用返回。'),
    claimed: z.boolean().describe('这个空间是否已被某个账号认领。'),
  } satisfies { [K in keyof SpaceCredential]-?: z.ZodType<SpaceCredential[K]> };

  registry.registerTool('create_space', {
    title: '申请空间密钥',
    description: '为这位用户申请一个持久空间：返回 spaceId 与 spaceKey。保存 spaceKey 并在后续 create_map / get_map / patch_map / list_maps 中复用，同一个 key 下的地图互相可见。密钥只在这次返回，不能自行编造，也不要发给别人（分享请用 share_map）。请求已带账号 API Key 时，新空间直接归该账号。',
    inputSchema: {},
    // The one tool whose entire result *is* a credential, so the one tool that
    // has to say the credential out loud. `structuredContent` is not what every
    // host puts in front of the model: declaring the shape asks for it, and the
    // text block below carries the same key for the hosts that drop it anyway.
    // Every other minting tool already passes its secret in the text, inside
    // `editUrl` or `previewUrl` — this one had no URL to hide it in.
    outputSchema: spaceCredentialShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async () => {
    try {
      const credential = store.createSpace(httpPrincipal.account?.id);
      // `spaceId` names the space; `spaceKey` opens it. Printing only the id
      // under the words 请保存 spaceKey handed over the half that authorises
      // nothing and looked like an answer — the next call spent the id as a key
      // and got 403, with the real key sitting in a field nobody read.
      const text = [
        `已创建空间 ${credential.spaceId}`,
        `spaceKey：${credential.spaceKey}`,
        '现在就保存这行 spaceKey：它只在这一次返回，之后 create_map / get_map / patch_map / list_maps 都要带上它。spaceId 只是空间的名字，当密钥用会被拒绝。不要把 spaceKey 给别人，分享请用 share_map。',
      ].join('\n');
      return { content: [{ type: 'text' as const, text }], structuredContent: { ...credential } };
    } catch (e) { return failure(e); }
  });

  registry.registerTool('list_maps', {
    title: '列出空间里的地图',
    description: '用 spaceKey 列出同一空间的地图摘要（id、标题、版本、更新时间、地址）。不返回图层数据，也不返回任何密钥。已在 HTTP Authorization 中传入账号 API Key 时可以省略 spaceKey，此时列出该账号名下全部地图。',
    inputSchema: { spaceKey: spaceKeyArg },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ spaceKey }) => {
    try {
      const principal = spaceKey ? principalFromBearer(store, spaceKey) : { ...httpPrincipal };
      if (spaceKey && !principal.space) throw new DomainError(403, '需要空间密钥', '传入 create_space 返回的 spaceKey。');
      const spaceIds = [...new Set([
        ...(principal.space ? [principal.space.id] : []),
        ...(!spaceKey && principal.account ? store.access.spacesOfAccount(principal.account.id).map(space => space.id) : []),
      ])];
      if (!spaceIds.length) throw new DomainError(403, '需要空间密钥或账号 API Key', '传入 create_space 返回的 spaceKey，或在 MCP 客户端配置 Authorization: Bearer <API Key>。');
      const maps = store.access.summaries(store.access.mapIdsOfSpaces(spaceIds));
      const info = { ...(principal.space && spaceKey ? { spaceId: principal.space.id } : {}), maps };
      return { content: [{ type: 'text' as const, text: JSON.stringify(info) }], structuredContent: info };
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'create_map', {
    title: '创建可编辑地图', description: '开始绘制一张新地图，一次调用即可。id 可省略。可靠重试请先 create_space 并保存 spaceKey，再复用 requestId 与原载荷。带 id 的重试仍需要该图写权限；省略 id 且提供 requestId 时必须有 spaceKey，否则返回 400。传入已保存的 spaceKey 把地图放进同一空间；不传时，匿名调用会新建空间并在响应中返回一次 spaceKey，而带账号 API Key 的调用落进该账号的默认空间、不返回密钥，因此也没有 editUrl 可以交给用户——需要用户能直接打开的编辑链接时，请先 create_space 再把 spaceKey 传进来。返回 editUrl 给用户编辑（含空间密钥，不是分享链接），只读分享请调用 share_map。map.layers 支持 route/spots/geojson；地点 at 为 [经度,纬度]。道路规划传停靠点并省略 path，默认自驾同时省略 routing；非默认交通方式才指定 routing.profile（walking/cycling，source 只是必填声明标签），部署的路由服务会尝试解算道路几何和车程；不要把停靠点复制成直线 path，否则会阻止自动解算。检查 routingStatus 和 stats.distanceKind，straight 只代表示意，不是已规划道路。多日行程每点写 day，保留默认相邻日期配色。只在有真实供应方几何时自行传 path/routing。示例和排错见 get_guide(section="quickstart" / "routing" / "days")。get_map 摘要不含几何。候选餐厅/住宿/景点请用 kind=spots 加 point.icon，不要把底图 POI 全做成可交互地点。intents 可在地图/图层/地点三级保存规划意图。',
    inputSchema: {
      id: z.string().min(1).max(80).optional(),
      map: toolSchema(MapInputSchema, { looseFields: ['geojson'] }),
      spaceKey: spaceKeyArg,
      requestId: z.string().min(1).max(128).optional().describe('重试去重键。带 id 时按该 id 去重；省略 id 时去重范围是目标空间（spaceKey，或账号 API Key 对应的默认空间），因此必须能确定目标空间。既没有 id 也没有空间时无法保证幂等，会返回 400。'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta,
  }, async ({ id, map, spaceKey, requestId }) => {
    try {
      const principal = principalFor(undefined, { spaceKey });
      if (spaceKey && !principal.space) throw new DomainError(403, '创建地图需要空间密钥', '先调用 create_space 取得 spaceKey；分享令牌不能作为目标空间密钥。');
      // Without an explicit id a retry would mint a fresh UUID and create a
      // second map, so the request id — scoped to the space that will hold it —
      // reserves one id for the whole logical creation.
      const result = await store.create(map, {
        id, requestId, key: principal.space?.key, accountId: principal.account?.id,
      });
      const held = { spaceId: result.spaceId, spaceKey: result.spaceKey ?? spaceKey, editKey: result.spaceKey ?? spaceKey };
      return success(result, held, accessFor(result.id, principal, result), { link: true });
    } catch (e) { return failure(e); }
  });

  /** Access as seen by a caller that also holds a key this call minted. */
  const accessFor = (id: string, principal: Principal, result?: WriteResult): MapAccess =>
    requireRead(store, id, result?.spaceKey && result.spaceId ? { ...principal, space: { id: result.spaceId, key: result.spaceKey, accountId: null } } : principal).access;

  registerAppTool(registry, 'get_map', {
    title: '查看地图与用户改动',
    description: [
      '默认返回地点摘要、路由指标、意图与语义增量，不向模型发送路线几何。需要 spaceKey（旧地图用 editKey）、分享得到的 previewToken，或 HTTP Authorization 中的账号 API Key / spaceKey；地图 ID 本身不授予读取权限。',
      'changed 表示相对 sinceVersion 是否有任何改动（不论出自用户还是 agent），unchanged 为其反义，二者不会同时为 false；hasUserChanges / hasAgentChanges 分别给出来源。',
      '传 since 时窗口就是该版本；不传 since 时窗口是当前凭据对应作者的上次写入之后，返回的 sinceVersion 会说明实际窗口。多个 Agent 共用凭据时须各自保存已读版本并显式传 since。since 等于当前版本时只返回 {changed:false, unchanged:true}。',
      'view=affected 只返回 since 之后受影响的图层和地点；view=changes 只读事件；view=full 显式取完整数据。includeGeometry/includeHistory 可覆盖默认裁剪。',
      'layer.routingStatus 说明道路几何的来源与是否被简化；简化不会改变路由提供方的里程和车程。传 spaceKey 会返回可以交给用户的编辑链接；只靠账号 API Key 时嵌入卡片一样可编辑，但没有编辑链接可交付。读取不会消费事件。',
    ].join('\n'),
    inputSchema: {
      id: z.string(),
      since: z.number().int().nonnegative().optional(),
      view: z.enum(['summary', 'changes', 'full', 'affected']).optional(),
      includeGeometry: z.boolean().optional(),
      includeHistory: z.boolean().optional(),
      editKey: z.string().max(512).optional(),
      spaceKey: spaceKeyArg,
      previewToken: previewTokenArg,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, _meta: meta,
  }, async ({ id, since, view, includeGeometry, includeHistory, editKey, spaceKey, previewToken }) => {
    try {
      const principal = principalFor(id, { spaceKey, editKey, previewToken });
      const access = requireRead(store, id, principal).access;
      // Without `since` the window is this caller's own last write, not the
      // map's — on a shared map another Agent's write would otherwise close a
      // window over changes this one never read.
      return success(store.get(id, since, access.authorId), heldBy(principal, { spaceKey, editKey, previewToken }, access), access, { view, since, present: { includeGeometry, includeHistory } });
    } catch (e) { return failure(e); }
  });

  registry.registerTool('subscribe_map', {
    title: '订阅地图改动',
    description: '取得独立 WebSocket 订阅地址和协议。这个工具本身不建立长连接，也不保证自动唤醒模型；调用方需保持 WS 连接，断线后 GET 补齐。需要该地图的读取权限。',
    inputSchema: { id: z.string(), spaceKey: spaceKeyArg, editKey: z.string().max(512).optional(), previewToken: previewTokenArg },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id, spaceKey, editKey, previewToken }) => {
    try {
      const access = requireRead(store, id, principalFor(id, { spaceKey, editKey, previewToken })).access;
      const map = store.get(id);
      const ws = `${store.publicUrl.replace(/^http/, 'ws')}/m/${id}`;
      const info = {
        id, version: map.version, websocket: ws, read: `${store.publicUrl}/m/${id}`, access,
        protocol: '私有地图必须先认证：以 Authorization: Bearer <spaceKey|previewToken> 连接，或连上后立即发送 {type:"auth",key:"<spaceKey>"} 或 {type:"auth",previewToken:"..."}；10 秒内未通过认证会被关闭，未认证期间不会收到任何地图数据。认证后收到 {type:"edit",changes,version} 时 GET 地图。有编辑权限时可发送 {type:"suggest",text,highlight:["地点名"]}；只读预览不能发送建议。分享被撤销或会话注销后连接会被关闭。',
      };
      return { content: [{ type: 'text', text: JSON.stringify(info) }], structuredContent: info };
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'patch_map', {
    title: '局部更新地图', description: [
      'Agent 按 baseVersion 原子修改受影响的地点/图层/路段，保留未涉及的用户改动。用户改线后请填写 reason，说明为什么这样改（界面会展示）。',
      '多 Agent 比较方案用 layer.add 在同一地图新增各自图层，保留其他方案；具体流程见 get_guide(section="collaboration")。新增道路路线省略 path 触发自动解算，多日填写每点 day；解算和跨天配色见 get_guide(section="routing" / "days")。',
      '需要 spaceKey（旧地图可用其自身的 editKey），或 HTTP Authorization 中已带账号 API Key / spaceKey。',
      '常用操作短例：',
      '{"op":"point.update","layerId":"plan-a","pointId":"a3","patch":{"day":4,"note":"住一晚"}}',
      '{"op":"point.reorder","layerId":"plan-a","pointId":"a13","toIndex":0} —— 单点移动；',
      '{"op":"points.reorder","layerId":"plan-a","pointIds":["a3","a2","a1"]} —— 一次提交整段新顺序（这里是把 3 个点反转；13 个点同样只需这一条），pointIds 必须是该图层全部点 id 的一次排列，重复/遗漏/陌生 id 会整批拒绝；',
      '{"op":"layer.add","layer":{"name":"候选温泉","kind":"spots","points":[{"name":"某温泉","at":[128.1,47.3],"icon":"park"}]}}',
      '{"op":"intent.set","scope":"layer","layerId":"plan-a","text":"每天开车不超过 5 小时","priority":"must"}',
      '{"op":"route.leg.update","layerId":"plan-a","fromPointId":"a1","toPointId":"a2","patch":{"traffic":"heavy","delayMinutes":25}}',
      '未知操作和未知 patch 字段会被拒绝并指出字段路径，不会静默忽略、也不会部分写入；layer.update.patch 不接受 points。',
      'layer.update 可更新 path/routing；移动或增删重排节点会清除旧路径和车程，Cartula 在配置了路由服务时重新解算。事件来源为 agent；requestId 用于重试去重。非破坏性局部更新。',
    ].join('\n'),
    inputSchema: { id: z.string(), spaceKey: spaceKeyArg, editKey: z.string().min(1).max(512).optional(), previewToken: previewTokenArg, baseVersion: z.number().int().min(1), operations: z.array(toolSchema(EditOperationSchema, { looseFields: ['geojson', 'point', 'patch', 'layer'] })).min(1).max(100), requestId: z.string().min(1).max(128).optional(), reason: z.string().min(1).max(2000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta,
  }, async ({ id, spaceKey, editKey, previewToken, baseVersion, operations, requestId, reason }) => {
    try {
      // A share token is named here because an editable one authorises exactly
      // this: changing the map it points at. Whether the token in hand is that
      // kind is the server's answer, given by `requireWrite` below — a
      // read-only share still gets 403 rather than a misleading 400.
      if (!spaceKey && !editKey && !previewToken && !httpPrincipal.account && !httpPrincipal.space && !httpPrincipal.preview) {
        throw new DomainError(400, 'patch_map 需要 spaceKey、editKey、可编辑分享的 previewToken 或账号 API Key', '传入 create_space / create_map 返回的 spaceKey，或在 MCP 客户端配置 Authorization: Bearer <API Key>；协作者请传对方给的 previewToken。');
      }
      const principal = principalFor(id, { spaceKey, editKey, previewToken });
      const grant = requireWrite(store, id, principal);
      const map = await store.edit(id, grant.writeAuth, baseVersion, operations, requestId, 'agent', reason);
      return success(map, heldBy(principal, { spaceKey, editKey, previewToken }, grant.access), grant.access, { link: true });
    } catch (e) { return failure(e); }
  });

  // Sharing returns a link rather than a map snapshot. Both the Agent and the
  // embedded App can call it, without advertising a new map UI result.
  registry.registerTool('share_map', {
    title: '生成、列出或停用分享链接',
    description: [
      '所有者专用。生成一条新的分享链接（previewToken + previewUrl），可反复生成，旧链接不会自动失效；revoke:true 一次撤销这张地图的全部分享（只读和可编辑一起），之前基于分享的收藏也会随之失效。',
      'list:true 列出这张地图还有效的分享：每条只有 id、生成时间和读写权限，没有令牌——链接的明文只在生成的那一次返回，之后谁也取不回来。revokeId 停用其中一条，其余不受影响。',
      'canWrite 省略或 false：只读分享，可以查看、导出、订阅、收藏和复制。',
      'canWrite:true：可编辑分享，对方和对方的 Agent 可以改这一张地图的图层、地点与路线。仍然不能删除地图、再生成分享、认领空间，也看不到空间密钥；随时可以 revoke 收回。多人协作请用它，不要把 spaceKey 或 #space= 链接发出去——那把钥匙开的是你整个空间的每一张地图，带删除权，而且无法撤销。',
      '对方写入时会带上自己的 author 标识，你的 Agent 用 get_map 读增量就能分辨哪些改动不是自己做的。',
    ].join('\n'),
    inputSchema: {
      id: z.string(), spaceKey: spaceKeyArg, editKey: z.string().max(512).optional(),
      revoke: z.boolean().optional(), canWrite: z.boolean().optional().describe('true 时签发可编辑分享；省略为只读。'),
      list: z.boolean().optional().describe('true 时只列出现有分享，不生成新的。'),
      revokeId: z.string().max(128).optional().describe('停用 list 里的某一条分享，其余保留。'),
      requestId: z.string().min(1).max(128).optional().describe('生成分享的业务去重键。同一次生成的重试复用此值；新分享使用新值。服务重启或短期结果过期后会明确提示已生成，不会重复签发。'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ id, spaceKey, editKey, revoke, canWrite, list, revokeId, requestId }) => {
    try {
      requireOwner(store, id, principalFor(id, { spaceKey, editKey }));
      // Listing first: it is the one branch that mints and revokes nothing, so
      // a call that asks for it never has to be read for its other arguments.
      if (list) {
        const links = store.access.previews(id);
        return { content: [{ type: 'text' as const, text: shareListText(links) }], structuredContent: { links } };
      }
      if (revokeId) {
        if (!store.access.revokePreview(id, revokeId)) throw new DomainError(404, '这条分享链接不存在', '先用 list:true 看看这张地图还有哪些分享。');
        const links = store.access.previews(id);
        return { content: [{ type: 'text' as const, text: `已停用分享 ${revokeId}。${shareListText(links)}` }], structuredContent: { ok: true, revoked: 1, links } };
      }
      if (revoke) {
        const revoked = store.access.revokePreviews(id);
        return { content: [{ type: 'text' as const, text: `已停用这张地图的全部分享（${revoked} 条）。` }], structuredContent: { ok: true, revoked } };
      }
      const link = store.access.createPreview(id, canWrite === true, requestId);
      const text = link.canWrite
        ? `可编辑分享链接（可以发给协作者）：${link.previewUrl}\n对方可以改这一张地图，不能删除它、再分享或认领你的空间。要收回时调用 share_map({id,spaceKey,revoke:true})。`
        : `只读分享链接（可以发给别人）：${link.previewUrl}`;
      return { content: [{ type: 'text' as const, text }], structuredContent: { ...link } };
    } catch (e) { return failure(e); }
  });

  // Also no map snapshot: what it returns is the absence of one.
  registry.registerTool('delete_map', {
    title: '删除地图',
    description: '所有者专用，且不可撤销：地图本身、全部历史版本、全部只读分享链接，以及基于这些分享的收藏都会一起消失，空间密钥之后也打不开它。请先向用户确认再调用；只是不想再看到它、或想换一张地图继续，都不要用这个工具。需要 spaceKey（旧地图用其自身的 editKey），或 HTTP Authorization 中的账号 API Key。',
    inputSchema: { id: z.string(), spaceKey: spaceKeyArg, editKey: z.string().max(512).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, _meta: { ui: { visibility: ['model', 'app'] } },
  }, async ({ id, spaceKey, editKey }) => {
    try {
      const grant = requireOwner(store, id, principalFor(id, { spaceKey, editKey }));
      const removed = store.delete(id, grant.writeAuth);
      return { content: [{ type: 'text' as const, text: `已删除「${removed.title}」（${removed.id}）。这张地图和它的历史版本、分享链接都不再存在。` }], structuredContent: { ok: true, ...removed } };
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'copy_map', {
    title: '复制地图到自己的空间',
    description: '把一张能读到的地图复制成新的独立地图：只带标题、图层和意图，不复制历史、归属、密钥或分享。源地图的读取凭证（spaceKey / editKey / previewToken）与目标空间的写入凭证（targetSpaceKey）分开传。未指定 targetSpaceKey 时会新建空间并返回一次 spaceKey；此时 requestId 无法识别重试，需要幂等请先 create_space 再指定 targetSpaceKey。',
    inputSchema: {
      id: z.string(), spaceKey: spaceKeyArg, editKey: z.string().max(512).optional(), previewToken: previewTokenArg,
      targetSpaceKey: spaceKeyArg, title: z.string().max(120).optional(),
      requestId: z.string().min(1).max(128).optional().describe('重试去重键，去重范围是 targetSpaceKey 指向的目标空间，因此必须同时提供 targetSpaceKey。未指定目标空间时无法保证幂等（每次调用都会新建空间与副本，且新空间密钥只返回一次），会返回 400 并要求先 create_space，而不是给出兑现不了的承诺。重试请保持源地图与 title 不变，内容不同会返回 409。'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta,
  }, async ({ id, spaceKey, editKey, previewToken, targetSpaceKey, title, requestId }) => {
    try {
      requireRead(store, id, principalFor(id, { spaceKey, editKey, previewToken }));
      let target: string | undefined;
      if (targetSpaceKey) {
        const space = store.access.spaceByKey(targetSpaceKey);
        if (!space) throw new DomainError(403, '目标空间密钥无效', '用 create_space 申请，或省略 targetSpaceKey 让 Cartula 新建一个。');
        // The key authorises the space whether or not an account has since
        // claimed it: claiming adds a login, it does not retire the Agent's key.
        target = space.id;
      }
      const copied = await store.copy(id, { spaceId: target, accountId: target ? undefined : httpPrincipal.account?.id, title, requestId });
      const key = copied.spaceKey ?? targetSpaceKey;
      const held: Held = { spaceId: copied.spaceId, spaceKey: key, editKey: key };
      const destination: Principal = key && copied.spaceId ? { space: { id: copied.spaceId, key, accountId: null } } : { ...httpPrincipal };
      const access = requireRead(store, copied.id, destination).access;
      return success(copied, held, access, { link: true });
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'submit_changes', {
    title: '把本轮用户修改交给 Agent',
    description: [
      '记录本轮意图并生成交接消息（不覆盖地图、不应用操作），返回结构化摘要。宿主支持 ui/message 时由 UI 发送；否则把返回的 message 复制回对话。mapId 与 id 等价。',
      '需要该地图的读取权限；只读（previewToken）时只返回摘要与交接消息，不会记录 intents。',
      'baseVersion = Agent 上次读到的版本，决定摘要窗口。currentVersion = 调用方提交时看到的版本：带 intents 时它是并发校验依据，地图已前进则返回 409 VERSION_CONFLICT 且不写入（intent 会覆盖同一 scope 的既有意图）；只提交草稿说明时不覆盖任何内容，只返回 staleView 与 changesSinceClientVersion 作为提示。不传 currentVersion 则不做并发校验。',
      'requestId 保证重试幂等：同一 requestId、同一 (userMessage, intents) 重放返回同一版本，不会重复写入草稿提交；去重先于版本判断，因此“写入成功但响应丢失”后的重试不会变成冲突。收到 409 后请重新读取地图，用新的 requestId 与新的 currentVersion 再提交。changes 不受支持，传入会被拒绝——操作请走 patch_map / edit_map。',
    ].join('\n'),
    inputSchema: {
      id: z.string().optional(),
      mapId: z.string().optional(),
      editKey: z.string().min(1).max(512).optional(),
      spaceKey: spaceKeyArg,
      previewToken: previewTokenArg,
      baseVersion: z.number().int().nonnegative().optional().describe('Agent 上次读到的版本，决定交接摘要的增量窗口'),
      currentVersion: z.number().int().min(1).optional().describe('调用方提交时看到的版本。带 intents 时作并发校验：地图已前进则 409 VERSION_CONFLICT，不写入；不带 intents 时仅返回 staleView / changesSinceClientVersion 提示。大于当前版本返回 400。同一 requestId 的重放先于该校验，因此响应丢失后的重试仍然成功'),
      userMessage: z.string().max(2000).optional(),
      intents: z.array(toolSchema(IntentSchema)).max(20).optional(),
      changes: z.array(z.unknown()).max(100).optional().describe('不受支持：submit_changes 只记录意图与交接，不应用操作。传入会被拒绝，请改用 patch_map（Agent）或 edit_map（UI）'),
      requestId: z.string().min(1).max(128).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, _meta: meta,
  }, async ({ id, mapId, editKey, spaceKey, previewToken, baseVersion, currentVersion, userMessage, intents, changes, requestId }) => {
    try {
      const mapId_ = mapId ?? id;
      if (!mapId_) throw new DomainError(400, '需要 id 或 mapId');
      // Advertised but never applied is the same silent half-success as a
      // dropped patch field, so say no instead of returning a cheerful result.
      if (changes?.length) {
        throw new DomainError(400, 'submit_changes 不应用 changes 里的操作', 'Agent 请用 patch_map 提交操作，UI 请用 edit_map；submit_changes 只记录 intents、草稿提交和交接消息。', {
          code: 'UNSUPPORTED_FIELD', field: 'changes', received: changes.length,
        });
      }
      const principal = principalFor(mapId_, { spaceKey, editKey, previewToken });
      const grant = requireRead(store, mapId_, principal);
      let map = store.get(mapId_, baseVersion);
      const view = store.viewStatus(mapId_, currentVersion);
      if (grant.access.editable) {
        // Derived only from userMessage and intents: a retry has to hash to the
        // same batch, or requestId de-duplication turns into a 409.
        const ops = [
          ...(intents ?? []).map(intent => ({ op: 'intent.set' as const, scope: intent.scope, text: intent.text, layerId: intent.layerId, pointId: intent.pointId, priority: intent.priority, status: intent.status })),
          { op: 'draft.commit' as const, note: userMessage?.trim() || '交给 Agent 继续规划' },
        ];
        // Intents replace whatever intent already occupies their scope, so a
        // submit that carries them is a write that can lose someone else's
        // work: it is compared against `currentVersion` and refused when the
        // map has moved. `store.edit` answers a requestId replay before that
        // check, so retrying a submission that already landed adds no second
        // write and returns the current snapshot rather than conflicting — it
        // is a fresh read, not a recording of the first response. A draft
        // commit alone replaces nothing and goes in against the live head.
        await store.edit(mapId_, grant.writeAuth, intents?.length && currentVersion !== undefined ? currentVersion : map.version, ops, requestId, 'user');
        // The handoff describes this whole round, not just the commit that
        // closed it, so re-read against the caller's own baseVersion.
        map = store.get(mapId_, baseVersion);
      }
      // The model sees the affected subset; the App, which a host may open
      // straight from this tool, needs the whole map in the hidden channel.
      const presented = presentMap(map, 'affected', baseVersion);
      const stale = view.staleView && view.changesSinceClientVersion?.length
        ? `\n提示：你提交时看到的是 v${view.clientVersion}，地图当前为 v${map.version}；其后的改动：${view.changesSinceClientVersion.slice(0, 3).join('；')}`
        : '';
      // A previewToken caller is a share recipient: hand the same token back so
      // their own Agent can act on it directly, instead of one that only works
      // for whoever holds this space's key. Never for the owner, even one who
      // named their own map's token alongside spaceKey — see `shareCredentialFor`.
      const shareCredential = shareCredentialFor(store, mapId_, principal, grant.access);
      const message = `${planningMessage(map, baseVersion ?? 0, shareCredential)}${userMessage ? `\n用户：${userMessage}` : ''}${stale}`;
      return {
        content: [{ type: 'text' as const, text: message }],
        structuredContent: { ...presented, ...view, ...(userMessage ? { userMessage } : {}), access: grant.access, message },
        // Credentials only as far as this call proved them: a read-only submit
        // still initialises the App, without gaining rights. The hidden copy is
        // the full history, not the caller's window: the view counts this
        // round's changes from it.
        _meta: appContext(store.get(mapId_, 0), heldBy(principal, { spaceKey, editKey, previewToken }, grant.access), grant.access),
      };
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'get_map_state', {
    description: 'UI 专用完整状态通道，几何只放在宿主隐藏的 _meta 中。需要 spaceKey / editKey / previewToken，或 HTTP Authorization 中的账号 API Key。',
    inputSchema: { id: z.string(), editKey: z.string().max(512).optional(), spaceKey: spaceKeyArg, previewToken: previewTokenArg },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    _meta: appMeta,
  }, async ({ id, editKey, spaceKey, previewToken }) => {
    try {
      const principal = principalFor(id, { spaceKey, editKey, previewToken });
      const access = requireRead(store, id, principal).access;
      return success(store.get(id, 0), heldBy(principal, { spaceKey, editKey, previewToken }, access), access, { appOnly: true });
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'record_handoff', {
    description: [
      'UI 专用：记录本轮修改确实已经交给对话（宿主接受了 ui/message，或用户复制了消息）。',
      '只更新交接边界，不产生版本、事件或改动记录；边界只前进，且不会超过当前版本。',
      '与 Agent 写入版本（get_map 默认增量起点）是两个不同的边界：submit_changes 记录的草稿提交只代表提交过，不代表送达。',
    ].join('\n'),
    inputSchema: { id: z.string(), version: z.number().int().nonnegative(), editKey: z.string().max(512).optional(), spaceKey: spaceKeyArg, previewToken: previewTokenArg },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: appMeta,
  }, async ({ id, version, editKey, spaceKey, previewToken }) => {
    try {
      const grant = requireWrite(store, id, principalFor(id, { spaceKey, editKey, previewToken }));
      const recorded = store.recordHandoff(id, grant.writeAuth, version);
      return { content: [{ type: 'text' as const, text: JSON.stringify(recorded) }], structuredContent: recorded };
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'edit_map', {
    description: 'UI 专用：Cartula 界面提交语义编辑，自动生成版本和用户 changes。Agent 请用 patch_map。',
    inputSchema: { id: z.string(), editKey: z.string().max(512).optional(), spaceKey: spaceKeyArg, previewToken: previewTokenArg, baseVersion: z.number().int().min(1), operations: z.array(toolSchema(EditOperationSchema, { looseFields: ['geojson', 'point', 'patch', 'layer'] })).min(1).max(100), requestId: z.string().min(1).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: appMeta,
  }, async ({ id, editKey, spaceKey, previewToken, baseVersion, operations, requestId }) => {
    try {
      const principal = principalFor(id, { spaceKey, editKey, previewToken });
      const grant = requireWrite(store, id, principal);
      return success(await store.edit(id, grant.writeAuth, baseVersion, operations, requestId), heldBy(principal, { spaceKey, editKey, previewToken }, grant.access), grant.access, { appOnly: true });
    } catch (e) { return failure(e); }
  });

  registerAppTool(registry, 'replace_map', {
    description: 'Cartula UI 导入完整地图（破坏性全量替换），记录为用户改动并保留 Agent 的读取游标。',
    inputSchema: { id: z.string(), editKey: z.string().max(512).optional(), spaceKey: spaceKeyArg, previewToken: previewTokenArg, baseVersion: z.number().int().min(1), map: toolSchema(MapInputSchema, { looseFields: ['geojson'] }), requestId: z.string().min(1).max(128).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: appMeta,
  }, async ({ id, editKey, spaceKey, previewToken, baseVersion, map, requestId }) => {
    try {
      const principal = principalFor(id, { spaceKey, editKey, previewToken });
      const grant = requireWrite(store, id, principal);
      return success(await store.replaceByUser(id, grant.writeAuth, baseVersion, map, requestId), heldBy(principal, { spaceKey, editKey, previewToken }, grant.access), grant.access, { appOnly: true });
    } catch (e) { return failure(e); }
  });

  const tileOrigin = new URL(tileUrl.replace(/\{[zxy]\}/g, '0')).origin;
  const publicOrigin = new URL(store.publicUrl).origin;
  const connectDomains = [...new Set([tileOrigin, publicOrigin])];
  // Every address this App has ever had answers with the build running now.
  //
  // The versioned name exists so a host with a cache has no reason to ask for
  // the old one — not so the old one should break. A host caches
  // `_meta.ui.resourceUri` (Claude does), so after a deploy it may well ask for
  // the previous release's name; answering "no such resource" would render
  // nothing at all, which is worse than the stale copy the versioning was
  // introduced to prevent. So the name it asks for only decides how stale its
  // idea of the *name* is, never whether it gets HTML.
  const appPage = (uri: string) => async () => ({
    // `release` travels in the page so the App declares the build that served
    // it, not a constant compiled into the bundle months earlier.
    contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await appHtml({ mode: 'mcp', publicUrl: store.publicUrl, tileUrl, tileAttribution, styleUrl, release: RELEASE, ...(DIAGNOSTICS ? { diagnostics: true } : {}) }), _meta: {
      ui: { prefersBorder: false, csp: { connectDomains, resourceDomains: connectDomains } },
      'openai/widgetDescription': 'Cartula 展示 Agent 提供的地图，并让用户直接编辑图层与路线。',
      'openai/widgetPrefersBorder': false,
      'openai/widgetCSP': { connect_domains: connectDomains, resource_domains: connectDomains },
      // Codex 内嵌高度取 min(max(intrinsicHeight ?? heightHint ?? 240, minFrameHeight ?? 200), 720)：
      // hint 给初始高度，minFrameHeight 防止后续测量把帧压回 240。核对 Codex 26.901.51231 实现，两者均有读取逻辑；属于内部兼容项。
      'openai/widgetHeightHint': 720,
      'openai/widgetMinFrameHeight': 720,
    } }],
  });
  const publish = (uri: string, name: string, description: string) =>
    registerAppResource(server, name, uri, { description, mimeType: RESOURCE_MIME_TYPE }, appPage(uri));
  publish(RESOURCE_URI, 'Cartula 地图工作台', '可交互地图、路线比较与语义编辑');
  if (LEGACY_RESOURCE_URI !== RESOURCE_URI) {
    publish(LEGACY_RESOURCE_URI, 'Cartula 地图工作台（旧地址）', '兼容地址：与当前版本地址内容相同，供仍记着旧地址的宿主使用。');
  }
  // …including the ones this build has never heard of. Only the current release
  // is named in `resources/list` (`list: undefined` keeps the template out of
  // it), but any `map.<version>.html` still resolves, so a host holding *any*
  // previous release's name gets the current page rather than an error. There
  // is no registry of past releases to consult and no need for one: the answer
  // is the same for all of them.
  server.registerResource(
    'Cartula 地图工作台（历史版本地址）',
    new ResourceTemplate('ui://cartula/map.{version}.html', { list: undefined }),
    { description: '兼容地址：任何历史版本地址都返回当前构建。', mimeType: RESOURCE_MIME_TYPE },
    async uri => appPage(uri.href)(),
  );
  registerGuideMcp(server, registry);
  return { server: withoutUndeliverableNotifications(server), argumentKinds };
}

/**
 * Stop promising list-change notifications, because this server cannot send
 * any notification at all.
 *
 * `registerTool`/`registerResource` set `listChanged: true` unconditionally,
 * and that is a promise about the transport, not about the registry: it says
 * "I will tell you when this list changes", which entitles a client to cache
 * the list until it hears otherwise. `registerMcp` serves `/mcp` statelessly —
 * a fresh `McpServer` per POST, no session id, JSON responses, and `GET /mcp`
 * answered with 405 — so there is no stream to send one on and no session to
 * send it to. The promise can never be kept.
 *
 * That matters here rather than being a pedantic point. A tool definition
 * carries `_meta.ui.resourceUri`, so a client caching the tool list "until
 * notified" is also caching which App to render, and would keep rendering the
 * URI it learned once. Saying nothing leaves such a client to re-list on its
 * own terms, which is the behaviour this deployment actually supports.
 *
 * Reaching into `_capabilities` is the only way to unset what the SDK hardcodes
 * — `registerCapabilities` merges and refuses to run after `connect`. A
 * rename upstream would make this silently do nothing, so
 * `tests/server.test.ts` asserts the handshake over a real transport.
 */
function withoutUndeliverableNotifications(server: McpServer): McpServer {
  const capabilities = (server.server as unknown as { _capabilities?: Record<string, { listChanged?: boolean }> })._capabilities;
  for (const group of Object.values(capabilities ?? {})) {
    if (group && typeof group === 'object' && 'listChanged' in group) group.listChanged = false;
  }
  return server;
}
export async function registerMcp(app: FastifyInstance, store: MapStore, tileUrl: string, tileAttribution: string, styleUrl?: string) {
  app.post('/mcp', async (request, reply) => {
    const bearer = bearerOf(request.headers.authorization as string | undefined);
    const httpPrincipal = bearer ? principalFromBearer(store, bearer) : {};
    const { server, argumentKinds } = createMcpServer(store, tileUrl, tileAttribution, styleUrl, httpPrincipal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    observeCalls(request, transport, argumentKinds);
    await server.connect(transport);
    reply.hijack();
    reply.raw.on('close', () => { void server.close(); });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.route({ method: ['GET', 'DELETE'], url: '/mcp', handler: (_request, reply) => reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Stateless Streamable HTTP: use POST /mcp.' }, id: null }) });
}

/**
 * One log line per tool call, and the host's identity at initialize.
 *
 * The access log knows only `POST /mcp 200`: when a host mis-sends an argument
 * or the SDK refuses one, nothing there says which host, which tool, or why —
 * which is exactly what was missing when a Doubao client lost three tools and
 * the server had no record of it. The SDK offers no hook for the parameters it
 * rejects itself, so the answer is read on its way out through the transport.
 * Arguments are never logged: they carry space keys.
 */
function observeCalls(request: FastifyRequest, transport: StreamableHTTPServerTransport, argumentKinds: Map<string, Record<string, ArgumentKind>>): void {
  const client = String(request.headers['user-agent'] ?? '').slice(0, 160) || undefined;
  const messages: unknown[] = Array.isArray(request.body) ? request.body : [request.body];
  const pending = new Map<string | number, { tool: string; normalized: string[]; startedAt: number }>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params, id } = message as { method?: unknown; params?: { name?: unknown; arguments?: unknown; clientInfo?: unknown; protocolVersion?: unknown }; id?: string | number };
    if (method === 'initialize') {
      request.log.info({ mcp: { event: 'initialize', client, clientInfo: params?.clientInfo, protocolVersion: params?.protocolVersion } }, 'mcp initialize');
    } else if (method === 'tools/call' && typeof params?.name === 'string') {
      const normalized = normalizeArguments(params.arguments, argumentKinds.get(params.name) ?? {});
      if (id !== undefined) pending.set(id, { tool: params.name, normalized, startedAt: Date.now() });
    }
  }
  if (pending.size === 0) return;
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const id = 'id' in message && message.id !== null ? message.id : undefined;
    const call = id === undefined ? undefined : pending.get(id);
    if (call && id !== undefined) {
      pending.delete(id);
      request.log.info({ mcp: { event: 'call', client, tool: call.tool, normalized: call.normalized, ms: Date.now() - call.startedAt, ...outcomeOf(message) } }, 'mcp tool call');
    }
    return send(message, options);
  };
}

/**
 * How a tool call ended, as the host will see it. `rejected` is the SDK
 * refusing the arguments before the tool ran — it reports that as an
 * `isError` result whose text starts with the JSON-RPC code, or as a JSON-RPC
 * error, depending on the SDK version, and both are read here. `error` is the
 * tool's own refusal, with the status the payload carries.
 */
function outcomeOf(message: JSONRPCMessage): { outcome: 'ok' | 'error' | 'rejected'; status?: number; code?: number; message?: string } {
  if ('error' in message) return { outcome: 'rejected', code: message.error.code, message: message.error.message.slice(0, 300) };
  if (!('result' in message)) return { outcome: 'ok' };
  const result = message.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (!result.isError) return { outcome: 'ok' };
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  const refused = /^MCP error (-?\d+): ([\s\S]*)$/.exec(text);
  if (refused) return { outcome: 'rejected', code: Number(refused[1]), message: refused[2].slice(0, 300) };
  let status: number | undefined; let error: string | undefined;
  try { const payload = JSON.parse(text) as { status?: number; error?: string }; status = payload.status; error = payload.error; } catch { /* free text */ }
  return { outcome: 'error', status, message: (error ?? text).slice(0, 300) };
}
