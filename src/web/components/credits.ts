/**
 * Who Cartula owes credit to, and how a provider's own credit line is read.
 *
 * Two different obligations live here and they are not interchangeable:
 *
 *  - The **data** on screen. A basemap provider states its credit in the style
 *    or the TileJSON, and Cartula shows exactly that — parsed, never rewritten.
 *    OpenStreetMap-derived data additionally carries the ODbL, which is why the
 *    licence sentence appears only when the provider's own words name OSM: a
 *    deployment pointed at some other source must not be made to claim it.
 *  - The **code** in the bundle. Those licences are satisfied by shipping the
 *    notices, not by drawing anything on a map; the list below is the readable
 *    summary of `THIRD_PARTY_NOTICES.md`, which remains the full text.
 *
 * Pure: no DOM, no fetch. The parser exists precisely so that a provider's
 * HTML is never handed to `dangerouslySetInnerHTML` — it becomes data, and the
 * dialog builds its own links from it.
 */

export interface CreditPart {
  text: string;
  /** Present only for `http(s)` links; any other scheme becomes plain text. */
  href?: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', middot: '·', ndash: '–', mdash: '—',
};

function decode(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (!body.startsWith('#')) return ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1]?.toLowerCase() === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Tags out, entities in, whitespace collapsed. Script and style bodies go with
 * their tags: their text is not a credit, and echoing it would put a stranger's
 * code — harmless as text, but still theirs — into a licence dialog.
 */
const plain = (value: string): string =>
  decode(value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * A provider's attribution string as renderable parts.
 *
 * Attribution arrives as a fragment of HTML — that is the convention TileJSON
 * and style specs use — and the links in it are part of what the licence asks
 * for, so they are kept. Everything else is flattened to text: no tag survives
 * this function, and a link that is not `http(s)` keeps its label and loses its
 * href rather than becoming a `javascript:` target in someone's dialog.
 */
export function parseAttribution(value: string): CreditPart[] {
  const out: CreditPart[] = [];
  const push = (text: string, href?: string) => { if (text) out.push(href ? { text, href } : { text }); };
  const anchors = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let index = 0;
  for (let match = anchors.exec(value); match; match = anchors.exec(value)) {
    push(plain(value.slice(index, match.index)));
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    push(plain(match[4]), /^https?:\/\//i.test(href) ? href : undefined);
    index = match.index + match[0].length;
  }
  push(plain(value.slice(index)));
  return out;
}

/** Whether a set of credits describes OpenStreetMap-derived data. */
export function mentionsOsm(credits: string[]): boolean {
  return credits.some(credit => /openstreetmap|\bosm\b/i.test(credit));
}

export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
export const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/';

export interface OpenSourceComponent {
  /** npm name, so the notices and this list can be checked against each other. */
  pkg: string;
  name: string;
  version: string;
  license: string;
  url: string;
  /** What it does here — a licence list nobody can place is not information. */
  role: string;
}

/**
 * The main third-party components, mirroring `THIRD_PARTY_NOTICES.md`.
 *
 * Not the whole list: the notices file is, and it ships with every build. A
 * test keeps these versions equal to the ones in `package.json`, so a bump can
 * never leave this dialog quietly describing last year's dependency.
 */
export const OPEN_SOURCE_COMPONENTS: OpenSourceComponent[] = [
  { pkg: 'maplibre-gl', name: 'MapLibre GL JS', version: '6.7.0', license: 'BSD-3-Clause', url: 'https://github.com/maplibre/maplibre-gl-js', role: '底图渲染' },
  { pkg: '@deck.gl/core', name: 'deck.gl', version: '9.3.11', license: 'MIT', url: 'https://github.com/visgl/deck.gl', role: '路线与标注图层' },
  { pkg: 'react', name: 'React', version: '19.2.8', license: 'MIT', url: 'https://github.com/facebook/react', role: '界面框架' },
  { pkg: 'lucide-react', name: 'Lucide', version: '1.41.0', license: 'ISC', url: 'https://github.com/lucide-icons/lucide', role: '图标' },
  { pkg: '@modelcontextprotocol/sdk', name: 'MCP TypeScript SDK', version: '1.30.0', license: 'MIT', url: 'https://github.com/modelcontextprotocol/typescript-sdk', role: 'Agent 接入' },
  { pkg: 'fastify', name: 'Fastify', version: '5.12.3', license: 'MIT', url: 'https://github.com/fastify/fastify', role: '服务端' },
  { pkg: 'zod', name: 'Zod', version: '4.5.4', license: 'MIT', url: 'https://github.com/colinhacks/zod', role: '数据校验' },
];
