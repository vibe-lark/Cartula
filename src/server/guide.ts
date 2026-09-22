import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RELEASE } from './release.js';
import { LICENSE_NAME, REPOSITORY_URL } from '../core/release.js';
import { packageZip } from './archive.js';

// The installable file is also the wire payload. This relative path works from
// src/server and dist-server/server; the container ships skills/ alongside both.
const skillFile = new URL('../../skills/cartula/SKILL.md', import.meta.url);
export const SKILL_TEXT = readFileSync(skillFile, 'utf8');
const lastModified = statSync(skillFile).mtime.toISOString();
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const GUIDE_VERSION = digest(SKILL_TEXT);
export const GUIDE_URI = `cartula://skills/cartula/${GUIDE_VERSION}/SKILL.md`;
export const GUIDE_ALIAS = 'cartula://skills/cartula/SKILL.md';
export const SKILL_DOWNLOAD_PATH = '/skills/cartula/SKILL.md';
export const SKILL_PACKAGE_PATH = '/skills/cartula.zip';

const headings = [...SKILL_TEXT.matchAll(/^## ([a-z]+) — .+$/gm)];
const sections = Object.fromEntries(headings.map((heading, index) => [
  heading[1], SKILL_TEXT.slice(heading.index, headings[index + 1]?.index).trimEnd() + '\n',
]));
export const GUIDE_SECTIONS = ['all', ...Object.keys(sections)] as [string, ...string[]];
if (!sections.essentials) throw new Error('Cartula SKILL.md needs an essentials section for MCP instructions');

export function guideText(section = 'all'): string {
  if (section === 'all') return SKILL_TEXT;
  if (!Object.hasOwn(sections, section)) throw new Error(`Unknown guide section: ${section}`);
  return sections[section];
}

export const GUIDE_INSTRUCTIONS = `${sections.essentials}\n按需调用 get_guide({section}) 阅读完整流程。当前版本资源：${GUIDE_URI}\n稳定入口：${GUIDE_ALIAS}`;

const resource = (uri: string) => ({ uri, mimeType: 'text/markdown', text: SKILL_TEXT });

export function registerGuideMcp(server: McpServer, registry: Pick<McpServer, 'registerTool'>) {
  const metadata = {
    title: `Cartula Agent Skill · ${GUIDE_VERSION.slice(0, 8)}`,
    description: '标准 SKILL.md：多 Agent 分图层协作、跨天配色、道路自动解算、增量编辑和错误恢复。可单独下载安装。',
    mimeType: 'text/markdown', size: Buffer.byteLength(SKILL_TEXT),
    annotations: { audience: ['assistant', 'user'] as ('assistant' | 'user')[], priority: 0.9, lastModified },
    _meta: { 'cartula/guideVersion': GUIDE_VERSION, 'cartula/serverRelease': RELEASE },
  };
  server.registerResource('cartula-skill', GUIDE_URI, metadata, async () => ({ contents: [resource(GUIDE_URI)] }));
  server.registerResource('cartula-skill-latest', GUIDE_ALIAS, {
    ...metadata, title: 'Cartula Agent Skill · 当前版本', description: '稳定入口：读取本部署当前的 Cartula Skill；内容版本以资源列表中的哈希 URI 为准。',
  }, async () => ({ contents: [resource(GUIDE_ALIAS)] }));
  // Do not pretend an old hash still names today's text. Unknown revisions get
  // the standard resource-not-found error; clients can re-list or use the alias.
  registry.registerTool('get_guide', {
    title: '读取 Cartula 使用指南',
    description: '首次使用 Cartula，或需要协作图层、跨天配色、道路自动解算和冲突恢复示例时调用。只读、无需地图或凭据。省略 section 读取完整标准 SKILL.md；也可按节读取。不安装 Skill、不修改地图。',
    inputSchema: { section: z.enum(GUIDE_SECTIONS).optional().describe('all 全文；essentials 核心约定；quickstart 创建；collaboration 协作；routing 道路；days 配色；editing 编辑；errors 排错；delivery 接入。') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ section }) => ({
    content: [
      { type: 'text' as const, text: guideText(section) },
      { type: 'text' as const, text: `Cartula Skill · SHA-256 ${GUIDE_VERSION} · 服务端 ${RELEASE}\n资源：${GUIDE_URI}\n稳定入口：${GUIDE_ALIAS}` },
    ],
    structuredContent: { uri: GUIDE_URI, version: GUIDE_VERSION, serverRelease: RELEASE, section: section ?? 'all', sections: GUIDE_SECTIONS, downloadPath: SKILL_DOWNLOAD_PATH, packagePath: SKILL_PACKAGE_PATH },
  }));
  server.registerPrompt('cartula_guide', {
    title: '使用 Cartula Skill', description: '主动把当前 Cartula Skill 加入对话，按图层协作并规划可编辑的道路行程。',
  }, async () => ({
    description: `Cartula Skill · ${GUIDE_VERSION}`,
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: SKILL_TEXT } }],
  }));
}

const SKILL_ZIP = packageZip({ 'cartula/SKILL.md': SKILL_TEXT });

/** The essentials as a bare bullet list, for embedding under another heading. */
const ESSENTIALS_BODY = sections.essentials.replace(/^## .*\n+/, '').trimEnd();

/**
 * `/llms.txt`: what an agent (or the person configuring one) needs to know
 * before touching this deployment — what Cartula is, that it is open source,
 * where the four entry points are, what a credential grants, and the
 * essentials of the Skill. It follows the llmstxt.org shape: one H1, one
 * blockquote summary, short sections, links to the longer documents.
 *
 * Every address is absolute and taken from `PUBLIC_URL`, because this text is
 * read out of context: pasted into a chat, fetched by a crawler, cached by a
 * host. `/llms-full.txt` is the same text followed by the complete Skill, for
 * readers who want everything in one request.
 */
export function llmsText(publicUrl: string, full = false): string {
  const base = publicUrl.replace(/\/+$/, '');
  const mcpConfig = JSON.stringify({ mcpServers: { cartula: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer <API_KEY>' } } } }, null, 2);
  const text = `# Cartula

> Cartula 是人和 Agent 共用的地图画布，给 Agent 加上空间表达能力：Agent 通过 MCP 或 REST 画出路线、地点和图层，人在图上拖点、改线、分享，改动再作为一段消息交回对话。${LICENSE_NAME} 开源，可自托管。

本文件描述部署在 ${base} 的 Cartula 服务，服务端版本 ${RELEASE}。下文所有地址都属于这个部署；别的部署有自己的地址、密钥和数据。

## 开源声明

- 许可证：${LICENSE_NAME} License，版权归 Cartula contributors。可以自由使用、复制、修改、分发和商用，须保留版权与许可声明；软件按“现状”提供，不附带任何保证。
- 源码仓库：${REPOSITORY_URL}
- 第三方组件（MapLibre GL、deck.gl、React、Fastify、MCP SDK 等）保留各自的许可证，清单见仓库中的 THIRD_PARTY_NOTICES.md。
- 底图与路网数据来自 OpenStreetMap 贡献者（ODbL）以及部署所配置的瓦片和路由供应方；署名以页面上的 attribution 为准。
- 自托管：仓库提供 Dockerfile 和 docker-compose.yml，需要 Node.js 22.13+；\`PUBLIC_URL\` 决定 MCP 地址与插件包里写入的地址。

## 接入方式

四个入口连接的是同一个服务、同一份数据：

1. MCP（Streamable HTTP，无状态）：${base}/mcp
   支持 MCP Apps 的宿主（如 Claude Desktop、Codex）会在对话里直接打开地图卡片；只把工具交给模型的宿主同样可用。客户端配置示例：

   \`\`\`json
${mcpConfig.split('\n').map(line => `   ${line}`).join('\n')}
   \`\`\`

   \`type\` 的写法因客户端而异（\`http\` / \`streamable-http\`），URL 和请求头相同。模型工具：create_space、list_maps、create_map、get_map、patch_map、submit_changes、share_map、copy_map、delete_map、subscribe_map、get_guide。不带凭据也能创建自己的空间和地图；读取或修改已有的私有地图需要相应凭据。
2. Agent Plugin（Agent Plugins 1.0.0，Skill + MCP 配置打包）：${base}/plugins/cartula.zip
   解压后以含 plugin.json 的 cartula/ 目录为插件根目录；当前版本、SHA-256 和下载地址见 ${base}/plugins/cartula/latest.json。
3. Agent Skill：${base}/skills/cartula/SKILL.md（ZIP：${base}/skills/cartula.zip）
   只连接 MCP 时调用 get_guide({section}) 读取同一份指南；支持资源的宿主读取 cartula://skills/cartula/SKILL.md。安装 Skill 之后仍需配置 MCP 连接。
4. REST：OpenAPI 3.1 描述见 ${base}/openapi.json
   POST /api/spaces 申请空间密钥；PUT /m/{id} 写入整张地图；GET /m/{id} 读取（可带 since 与 view）；PATCH /m/{id} 局部修改；凭据放在 Authorization: Bearer 请求头。

网页入口：${base}/app 打开演示画布，${base}/map/{id} 打开一张地图，分享链接形如 ${base}/map/{id}#preview=<token>。

## 凭据与权限

- spaceKey 授权整个空间：创建、读取、编辑、删除和分享其中每一张地图。只交给所有者和所有者的 Agent，不要写进分享消息。
- 账号 API Key（前缀 cak_）在网页的账号面板创建，等价于账号名下的所有空间；用于 MCP 客户端的 Authorization 请求头。
- previewToken 只授权一张地图：默认只读；用 canWrite:true 生成的分享可以编辑这一张图，但不能删除、再分享或认领空间。
- 服务端只保存凭据摘要，链接里的凭据放在 # 片段而不是 query；凭据不要写进标题、备注或公开日志。

## 核心约定

${ESSENTIALS_BODY}

## 完整文档

- [Cartula Skill（完整指南）](${base}/skills/cartula/SKILL.md)：创建、图层协作、道路解算、跨天配色、增量编辑、错误恢复与接入细节。
- [llms-full.txt](${base}/llms-full.txt)：本文件加上完整的 Skill 正文。
- [OpenAPI](${base}/openapi.json)：REST 接口定义。
- [README](${REPOSITORY_URL}#readme)：运行、部署、协议细节与宿主实测记录。
- [LICENSE](${REPOSITORY_URL}/blob/main/LICENSE) · [THIRD_PARTY_NOTICES](${REPOSITORY_URL}/blob/main/THIRD_PARTY_NOTICES.md)
`;
  return full ? `${text}\n---\n\n${SKILL_TEXT}` : text;
}

export function registerGuideHttp(app: FastifyInstance, publicUrl: string) {
  for (const [path, type, body, filename] of [
    [SKILL_DOWNLOAD_PATH, 'text/markdown; charset=utf-8', SKILL_TEXT, 'SKILL.md'],
    [SKILL_PACKAGE_PATH, 'application/zip', SKILL_ZIP, 'cartula.zip'],
    ['/llms.txt', 'text/plain; charset=utf-8', llmsText(publicUrl), undefined],
    ['/llms-full.txt', 'text/plain; charset=utf-8', llmsText(publicUrl, true), undefined],
  ] as const) {
    const etag = `"${digest(body)}"`;
    app.get(path, async (request, reply) => {
      reply.type(type).header('ETag', etag).header('Cache-Control', 'public, max-age=0, must-revalidate');
      if (filename) reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      const tags = request.headers['if-none-match']?.split(',').map(tag => tag.trim().replace(/^W\//, ''));
      if (tags?.some(tag => tag === etag || tag === '*')) return reply.code(304).send();
      return reply.send(body);
    });
  }
}
