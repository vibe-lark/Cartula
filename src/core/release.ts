/**
 * One release identity, declared by the service and by the App it serves.
 *
 * Both sides of the MCP handshake name it — `serverInfo` from
 * `createMcpServer`, the App's own `Implementation` in `ui/initialize` — so a
 * transcript identifies which build wrote a map and which build of the view the
 * person was looking at while they did. The App does not compile its own guess:
 * it takes the stamp from the page the service rendered for it, and falls back
 * to the version it was built from only when there is none. A mismatch between
 * the two therefore means something real (a frame that outlived a deploy),
 * rather than two constants that drifted apart.
 *
 * Pure module: no environment, no DOM. `src/server/release.ts` reads the
 * deployment's stamp; `src/web/adapters/mcp.ts` reads the page's.
 */

export const RELEASE_NAME = 'Cartula';

/** Where the source lives. Named on the landing page, in llms.txt and in the plugin README. */
export const REPOSITORY_URL = 'https://github.com/vibe-lark/Cartula';
export const LICENSE_NAME = 'MIT';

/** Kept in step with package.json — asserted by tests/contract.test.ts. */
export const RELEASE_VERSION = '0.4.14';

/**
 * A build stamp fit to appear in a handshake, or nothing.
 *
 * Deployers pass a commit sha or a CI build number. It ends up inside
 * `Implementation.version`, an HTML bootstrap and `/healthz`, so anything that
 * could change the meaning of one of those is refused rather than escaped: an
 * unusable stamp degrades to "no stamp", which is still a truthful answer.
 */
export function buildStamp(value: string | undefined | null): string | undefined {
  const stamp = value?.trim();
  return stamp && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(stamp) ? stamp : undefined;
}

/** `0.4.12+<build>` when the build is known, plain `0.4.12` when it is not. */
export function releaseId(build?: string | undefined | null): string {
  const stamp = buildStamp(build);
  return stamp ? `${RELEASE_VERSION}+${stamp}` : RELEASE_VERSION;
}

/**
 * A release rendered as one path segment, for naming the App resource.
 *
 * The App is published at a URI that carries its build, so a deploy cannot be
 * shadowed by a host holding an older copy of the same name — see
 * `RESOURCE_URI` in `src/server/mcp.ts`. `+` is legal in a URI but is decoded
 * as a space by enough software to be worth avoiding, so it becomes `-`.
 *
 * This only distinguishes builds that carry a stamp. A deployment with no
 * `CARTULA_BUILD` publishes every build of `0.4.4` under the same name, and
 * gets the old behaviour — which is a reason for a deployment to set one.
 */
export function resourceTag(release: string): string {
  return release.replace(/[^A-Za-z0-9.]+/g, '-');
}
