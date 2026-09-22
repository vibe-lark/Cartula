import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { packageZip } from './archive.js';
import { GUIDE_VERSION, SKILL_TEXT } from './guide.js';
import { RELEASE_VERSION } from './release.js';

export const PLUGIN_PACKAGE_PATH = '/plugins/cartula.zip';
export const PLUGIN_INDEX_PATH = '/plugins/cartula/latest.json';
const SPEC_VERSION = '1.0.0';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

function pluginBaseUrl(publicUrl: string): string {
  // Take only deployment configuration, never Host, forwarded headers or user credentials.
  const error = () => new Error('Plugin packaging requires an absolute HTTPS PUBLIC_URL (HTTP is allowed on loopback), without credentials, query or fragment');
  let url: URL;
  try { url = new URL(publicUrl); } catch { throw error(); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw error();
  return url.href.replace(/\/+$/, '');
}

/** The HTTP download and the release export use exactly the same bytes. */
export function buildPluginPackage(publicUrl: string) {
  const base = pluginBaseUrl(publicUrl);
  const mcpUrl = `${base}/mcp`;
  const manifest = {
    $schema: `https://agent-plugins.org/schemas/${SPEC_VERSION}/plugin.schema.json`,
    name: 'cartula', version: RELEASE_VERSION,
    description: '创建、读取、编辑和分享可协作的地图、路线与候选地点。',
    author: { name: 'Cartula contributors' }, homepage: base, license: 'MIT',
    keywords: ['map', 'route', 'travel', 'collaboration'],
  };
  const mcp = {
    $schema: `https://agent-plugins.org/schemas/${SPEC_VERSION}/mcp.schema.json`,
    mcpServers: { cartula: { type: 'streamable-http', url: mcpUrl } },
  };
  // Explicit allowlist: never bundle .env, database files, user keys or the repository.
  const files: Record<string, string> = {
    'plugin.json': json(manifest),
    'mcp.json': json(mcp),
    'skills/cartula/SKILL.md': SKILL_TEXT,
    LICENSE: readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8'),
    'README.md': `# Cartula Agent Plugin\n\n` +
      `本包遵循 Agent Plugins ${SPEC_VERSION}，包含 Cartula Skill 和远程 MCP 配置。标准包单位是本地目录；ZIP 只是传输格式。解压后选择含 plugin.json 的 cartula 目录作为插件根目录，ZIP 直接导入方式取决于宿主。宿主须同时支持 Agent Skills 和 Streamable HTTP MCP。\n\n` +
      `MCP：${mcpUrl}\n\n` +
      `无预设凭据时可以创建自己的空间和地图；读取或修改已有私有地图仍需相应授权。\n` +
      `访问账号已有地图时，在宿主的凭据管理中配置 Authorization: Bearer <API_KEY>。本包不含密钥；Cartula 当前使用 API Key / 空间或单图凭据，没有提供 OAuth 授权流程。\n\n` +
      `插件包版本：${RELEASE_VERSION}。Skill SHA-256：${GUIDE_VERSION}。\n` +
      `检查此部署当前发布的包：${base}${PLUGIN_INDEX_PATH}\n` +
      `该索引是 Cartula 的分发约定，不是 Agent Plugins 自动更新协议。下载、安装和更新由宿主或插件市场决定。\n` +
      `服务端更新在后续请求生效；工具定义、指南和 UI 的缓存刷新由宿主负责。本地 Skill 需要更新插件包才会更换；get_guide 可读取服务端当前指南，但不会安装或覆盖本地 Skill。\n`,
  };
  const archive = packageZip(Object.fromEntries(Object.entries(files).map(([path, body]) => [`cartula/${path}`, body])));
  const sha256 = digest(archive);
  // URL identity covers endpoint, Skill and all package contents, even if a version was reused.
  const filename = `cartula-${RELEASE_VERSION}-${sha256}.zip`;
  const index = {
    format: 'cartula-plugin-index-v1', name: manifest.name, version: manifest.version,
    agentPluginsVersion: SPEC_VERSION,
    downloadUrl: `${base}/plugins/${filename}`, sha256, size: archive.length,
    skillSha256: GUIDE_VERSION, mcpUrl,
  };
  return { files, archive, filename, index };
}

export function registerPluginHttp(app: FastifyInstance, publicUrl: string) {
  let cached: ReturnType<typeof buildPluginPackage> | undefined;
  const current = () => cached ??= buildPluginPackage(publicUrl);
  const send = (request: FastifyRequest, reply: FastifyReply, pinned: boolean, indexOnly = false, filename?: string) => {
    let pkg: ReturnType<typeof buildPluginPackage>;
    try { pkg = current(); } catch {
      // A LAN-only HTTP deployment can still run Cartula; it cannot publish a conforming remote plugin.
      return reply.code(503).header('Cache-Control', 'no-store').send({ error: '插件包暂不可用', hint: '请检查部署的 PUBLIC_URL：远程插件需要 HTTPS，且地址不能包含凭据、查询参数或片段。' });
    }
    if (pinned && filename !== pkg.filename) {
      return reply.code(404).header('Cache-Control', 'no-store').send({ error: '此部署不提供这个插件版本', indexPath: PLUGIN_INDEX_PATH });
    }
    const body = indexOnly ? json(pkg.index) : pkg.archive;
    const etag = `"${indexOnly ? digest(body) : pkg.index.sha256}"`;
    reply.type(indexOnly ? 'application/json; charset=utf-8' : 'application/zip')
      .header('ETag', etag)
      .header('Cache-Control', pinned ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate');
    if (!indexOnly) reply.header('Content-Disposition', `attachment; filename="${pkg.filename}"`);
    const tags = request.headers['if-none-match']?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
    if (tags?.some(tag => tag === '*' || tag === etag)) return reply.code(304).send();
    return reply.send(body);
  };
  app.get(PLUGIN_PACKAGE_PATH, (request, reply) => send(request, reply, false));
  app.get(PLUGIN_INDEX_PATH, (request, reply) => send(request, reply, false, true));
  app.get<{ Params: { artifact: string } }>('/plugins/cartula-:artifact.zip', (request, reply) =>
    send(request, reply, true, false, `cartula-${request.params.artifact}.zip`));
}
