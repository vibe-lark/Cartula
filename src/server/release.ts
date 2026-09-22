import { RELEASE_NAME, RELEASE_VERSION, buildStamp, releaseId } from '../core/release.js';

export { RELEASE_NAME, RELEASE_VERSION };

/** The build this process was deployed with (`CARTULA_BUILD`), if it was given one. */
export const BUILD = buildStamp(process.env.CARTULA_BUILD);

/**
 * What this service calls itself everywhere it is asked: the MCP `serverInfo`,
 * the OpenAPI document, `/healthz`, and the bootstrap of the App page it
 * renders — which is how the App comes to declare the very same string back.
 */
export const RELEASE = releaseId(BUILD);
