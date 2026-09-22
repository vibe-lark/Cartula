import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MapSnapshot } from '../core/types.js';
export function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Everything the App cannot ask anyone for, handed to it in the page itself.
 *
 * `release` is this service's build id. The App declares it back in the MCP
 * handshake, so a host sees one identifier on both sides of the exchange rather
 * than a server version and a constant compiled into the bundle — see
 * `src/core/release.ts`.
 */
export interface AppBootstrap {
  mode: 'mcp' | 'offline';
  /** Resolve navigation against Cartula, never against the sandbox's origin. */
  publicUrl?: string;
  snapshot?: MapSnapshot;
  tileUrl?: string;
  tileAttribution?: string;
  styleUrl?: string;
  release?: string;
  /**
   * Show the size-negotiation read-out on the card. Set by a deployment that
   * is being diagnosed (`CARTULA_DIAGNOSTICS=1`), never on by default — see
   * `src/web/adapters/diagnostics.ts`.
   */
  diagnostics?: boolean;
}

/** The bootstrap element, escaped so no field can close the script early. */
export function bootstrapScript(options: AppBootstrap) {
  return `<script id="cartula-bootstrap" type="application/json">${safeJson(options)}</script>`;
}

export async function appHtml(options: AppBootstrap) {
  const html = await readFile(resolve('dist/embed/app.html'), 'utf8');
  return html.replace('<!--CARTULA_BOOT-->', bootstrapScript(options));
}
