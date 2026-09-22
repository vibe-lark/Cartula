/**
 * Writable shares, authorship and per-author read cursors.
 *
 * The feature these cover is one sentence — "let a share edit one map" — and
 * three properties that sentence has to keep: the grant stays one map wide, it
 * never becomes ownership, and two Agents writing the same map can still tell
 * each other apart. The last one is why `author` and the cursor table exist:
 * `actor` says agent-or-user, which stops being an identity the moment a second
 * Agent can write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server/app.js';
import { PREVIEW_TOKEN_PREFIX, SPACE_KEY_PREFIX } from '../src/server/auth.js';
import type { MapInput, MapSnapshot, SemanticEvent, WriteResult } from '../src/core/types.js';
import type { MapAccess, PreviewLink, SpaceCredential } from '../src/core/access.js';

type App = Awaited<ReturnType<typeof createApp>>['app'];
type CreatedMap = WriteResult & SpaceCredential & { access: MapAccess };
type Read = MapSnapshot & { access: MapAccess; changed: boolean; sinceVersion: number };

const input: MapInput = { title: '东北行程', layers: [{ id: 'route', name: '路线', points: [
  { id: 'a', name: '哈尔滨', at: [126.6, 45.7] }, { id: 'b', name: '黑河', at: [127.5, 50.2] },
] }] };
const csrf = { 'x-cartula-request': '1' };
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

async function create(app: App, id: string, key?: string): Promise<CreatedMap> {
  const response = await app.inject({ method: 'PUT', url: `/m/${id}`, headers: key ? bearer(key) : {}, payload: input });
  assert.equal(response.statusCode, 200, `creating ${id}: ${response.body}`);
  return response.json();
}
async function share(app: App, map: CreatedMap, canWrite: boolean): Promise<PreviewLink> {
  const result = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/preview`, headers: bearer(map.spaceKey), payload: { canWrite } });
  assert.equal(result.statusCode, 200, result.body);
  const link = result.json<PreviewLink>();
  assert.equal(link.canWrite, canWrite, 'the link reports the grant it was minted with');
  assert.ok(!link.previewUrl.includes(map.spaceKey), 'a share never carries the space key');
  return link;
}
/** One layer-adding patch, as an Agent would send it. */
const addLayer = (name: string) => [{ op: 'layer.add', layer: { name, kind: 'spots', points: [{ name: `${name}的点`, at: [126.7, 45.8] }] } }];
async function patch(app: App, id: string, credential: string, baseVersion: number, operations: unknown[]) {
  return app.inject({ method: 'PATCH', url: `/m/${id}`, headers: bearer(credential), payload: { baseVersion, operations, requestId: randomUUID() } });
}
async function read(app: App, id: string, credential: string, since?: number): Promise<Read> {
  const url = since === undefined ? `/m/${id}` : `/m/${id}?since=${since}`;
  const response = await app.inject({ method: 'GET', url, headers: bearer(credential) });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function register(app: App) {
  const email = `${randomUUID()}@example.test`;
  const password = `Cartula-${randomBytes(14).toString('base64url')}9aZ!`;
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: csrf, payload: { email, password, passwordConfirm: password } });
  assert.ok([200, 201].includes(response.statusCode), response.body);
  const raw = response.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [String(raw)]).map(value => value.split(';')[0]).join('; ');
  return { headers: { ...csrf, cookie } };
}

test('SHARE-01 canWrite decides whether a share may edit, and defaults to read-only', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');

  const readOnly = await share(app, map, false);
  const refused = await patch(app, 'trip', readOnly.previewToken, 1, addLayer('酒店'));
  assert.equal(refused.statusCode, 403, 'a read-only share is still read-only');
  assert.equal(refused.body.includes('酒店'), false, 'a refused write leaves nothing behind');

  const writable = await share(app, map, true);
  const accepted = await patch(app, 'trip', writable.previewToken, 1, addLayer('候选酒店'));
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await read(app, 'trip', map.spaceKey)).layers.length, 2, 'the owner sees the collaborator\'s layer');

  // Omitting the field is the old client's request, and must keep meaning "read only".
  const legacyCall = await app.inject({ method: 'POST', url: '/api/maps/trip/preview', headers: bearer(map.spaceKey), payload: {} });
  assert.equal(legacyCall.statusCode, 200);
  assert.equal(legacyCall.json<PreviewLink>().canWrite, false, 'a share is read-only unless canWrite was asked for');
});

test('SHARE-02 a writable share edits one map and never becomes an owner', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const other = await create(app, 'other', map.spaceKey);
  const token = (await share(app, map, true)).previewToken;

  const access = await app.inject({ method: 'POST', url: '/api/maps/trip/access', headers: bearer(token), payload: {} });
  const granted = access.json<MapAccess>();
  assert.equal(granted.kind, 'shared-edit');
  assert.equal(granted.editable, true);
  assert.equal(granted.canShare, false, 'a collaborator cannot hand the map on');
  assert.equal(granted.canClaim, false, 'a collaborator cannot claim the space');
  assert.equal(granted.spaceId, undefined, 'a share learns nothing about the space behind the map');

  // The same space, a map the share does not name.
  assert.equal((await patch(app, 'other', token, other.version, addLayer('越权'))).statusCode, 403, 'the grant is one map wide');
  assert.equal((await app.inject({ method: 'GET', url: '/m/other', headers: bearer(token) })).statusCode, 403);

  assert.equal((await app.inject({ method: 'DELETE', url: '/api/maps/trip', headers: { ...bearer(token), ...csrf } })).statusCode, 403, 'a collaborator cannot delete the map');
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/trip/preview', headers: bearer(token), payload: { canWrite: true } })).statusCode, 403, 'a collaborator cannot mint further shares');
  const account = await register(app);
  assert.equal((await app.inject({ method: 'POST', url: '/api/maps/trip/claim', headers: { ...account.headers, ...bearer(token) }, payload: {} })).statusCode, 403, 'a collaborator cannot claim the space');

  // Revoking takes back every share of the map, editable ones included.
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/maps/trip/preview', headers: bearer(map.spaceKey) })).statusCode, 200);
  assert.equal((await patch(app, 'trip', token, 1, addLayer('撤销之后'))).statusCode, 403, 'a revoked share stops writing immediately');
});

test('SHARE-02b a writable share reaches every write path for its own map, and none for a new one', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const token = (await share(app, map, true)).previewToken;

  // Full replace of the map the share names: allowed, and attributed to the share.
  const replaced = await app.inject({ method: 'PUT', url: '/m/trip', headers: bearer(token), payload: { ...input, title: '同伴改过的行程' } });
  assert.equal(replaced.statusCode, 200, replaced.body);
  const events = (await read(app, 'trip', map.spaceKey, 0)).events as SemanticEvent[];
  assert.equal(events.find(e => e.version === 2)!.author!.startsWith('sh_'), true, 'the replace is recorded under the share, not the space');

  // A map id the share does not name is not its business, existing or not.
  assert.equal((await app.inject({ method: 'PUT', url: '/m/brand-new', headers: bearer(token), payload: input })).statusCode, 403, 'a share cannot create maps');
  assert.equal((await app.inject({ method: 'GET', url: '/m/brand-new' })).statusCode, 404, 'and nothing was created');
});

test('SHARE-03 every version says who wrote it, and access.authorId says which one is you', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const token = (await share(app, map, true)).previewToken;
  assert.equal((await patch(app, 'trip', token, 1, addLayer('候选酒店'))).statusCode, 200);

  const asOwner = await read(app, 'trip', map.spaceKey, 0);
  const asCollaborator = await read(app, 'trip', token, 0);
  const events = asOwner.events as SemanticEvent[];
  const [creation, hotels] = [events.find(e => e.version === 1)!, events.find(e => e.version === 2)!];

  assert.equal(creation.actor, 'agent');
  assert.equal(hotels.actor, 'agent', 'actor cannot separate them — both are Agents');
  assert.notEqual(creation.author, hotels.author, 'author can');
  assert.equal(creation.author, asOwner.access.authorId, 'the owner recognises its own first write');
  assert.equal(hotels.author, asCollaborator.access.authorId, 'the collaborator recognises its own');
  assert.notEqual(asOwner.access.authorId, asCollaborator.access.authorId);
  assert.equal(asCollaborator.access.authorId!.startsWith('sh_'), true, 'a share is named by its own id, not by the space');
  assert.equal(JSON.stringify(asCollaborator).includes(map.spaceKey), false, 'no read hands a collaborator the space key');
});

test('SHARE-04 one Agent\'s write does not close another Agent\'s unread window', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const token = (await share(app, map, true)).previewToken;

  // The owner's Agent wrote v1 and has read nothing since; the collaborator has
  // never written, so its window is still the whole map.
  assert.equal((await read(app, 'trip', map.spaceKey)).changed, false, 'the owner just wrote v1');

  assert.equal((await patch(app, 'trip', token, 1, addLayer('候选酒店'))).statusCode, 200);
  const ownerSees = await read(app, 'trip', map.spaceKey);
  assert.equal(ownerSees.changed, true, 'the collaborator\'s layer is news to the owner');
  assert.equal(ownerSees.sinceVersion, 1, 'the window is the owner\'s own last write, not the map\'s');
  assert.equal((await read(app, 'trip', token)).changed, false, 'the collaborator has just written; nothing is new for it');

  assert.equal((await patch(app, 'trip', map.spaceKey, 2, addLayer('机票接驳'))).statusCode, 200);
  assert.equal((await read(app, 'trip', map.spaceKey)).changed, false, 'the owner has now caught up');
  const collaboratorSees = await read(app, 'trip', token);
  assert.equal(collaboratorSees.changed, true, 'and the owner\'s layer is news to the collaborator');
  assert.equal(collaboratorSees.sinceVersion, 2);
  assert.equal(collaboratorSees.changes.some(line => line.includes('机票接驳')), true);
});

test('SHARE-06 a collaborator\'s Agent can work the map over MCP with nothing but the share token', async t => {
  const { app } = await createApp({ dbPath: ':memory:' });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'collaborator', version: '1' });
  t.after(async () => { await client.close(); await app.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));

  const map = await create(app, 'trip');
  const writable = (await share(app, map, true)).previewToken;
  const readOnly = (await share(app, map, false)).previewToken;

  const seen = await client.callTool({ name: 'get_map', arguments: { id: 'trip', previewToken: writable } });
  assert.equal(seen.isError, undefined, JSON.stringify(seen.content));
  assert.equal((seen.structuredContent as { access: MapAccess }).access.kind, 'shared-edit');

  // The whole point: an Agent holding only the share token can change the map.
  const written = await client.callTool({ name: 'patch_map', arguments: {
    id: 'trip', previewToken: writable, baseVersion: 1, operations: addLayer('候选酒店'), reason: '同伴负责住宿',
  } });
  assert.equal(written.isError, undefined, JSON.stringify(written.content));
  assert.equal((await read(app, 'trip', map.spaceKey)).layers.length, 2);

  // Nothing in the answer hands the collaborator more than it came with.
  const text = JSON.stringify(written);
  assert.equal(text.includes(map.spaceKey), false, 'a collaborator is never shown the space key');
  assert.equal(text.includes('#space='), false, 'nor an owner link');

  const refused = await client.callTool({ name: 'patch_map', arguments: { id: 'trip', previewToken: readOnly, baseVersion: 2, operations: addLayer('越权') } });
  assert.equal(refused.isError, true, 'a read-only share is still refused by the same tool');
  const notOwner = await client.callTool({ name: 'share_map', arguments: { id: 'trip', previewToken: writable } });
  assert.equal(notOwner.isError, true, 'and a collaborator cannot mint shares of its own');
});

test('SHARE-05 shares that predate writable sharing stay exactly as read-only as they were', async t => {
  const { app, store } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const token = (await share(app, map, false)).previewToken;

  // Reproduce the pre-migration row shape: no id, no `can_write` opinion.
  store.db.exec('UPDATE previews SET id=NULL, can_write=0');
  assert.equal((await patch(app, 'trip', token, 1, addLayer('越权'))).statusCode, 403, 'an old share cannot write');
  const access = await app.inject({ method: 'POST', url: '/api/maps/trip/access', headers: bearer(token), payload: {} });
  assert.equal(access.json<MapAccess>().kind, 'preview');
  assert.equal(access.json<MapAccess>().editable, false);
  assert.ok(access.json<MapAccess>().authorId, 'it still gets an id, so anything it did write can be attributed');
});

test('SHARE-07 submit hands a share recipient its own token back in the hand-off message, scoped to what the grant allows', async t => {
  const { app } = await createApp({ dbPath: ':memory:' }); t.after(() => app.close());
  const map = await create(app, 'trip');
  const writable = (await share(app, map, true)).previewToken;
  const readOnly = (await share(app, map, false)).previewToken;

  const writableSubmit = await app.inject({ method: 'POST', url: '/api/maps/trip/submit', headers: bearer(writable), payload: {} });
  assert.equal(writableSubmit.statusCode, 200, writableSubmit.body);
  const writableMessage = writableSubmit.json<{ message: string }>().message;
  assert.equal(writableMessage.includes(writable), true, 'the writable token is handed to the collaborator\'s own Agent');
  assert.match(writableMessage, /patch_map\(id="trip", previewToken="cpt_[^"]+", …\)/, 'a writable share gets a patch_map hint carrying the token');

  const readOnlySubmit = await app.inject({ method: 'POST', url: '/api/maps/trip/submit', headers: bearer(readOnly), payload: {} });
  assert.equal(readOnlySubmit.statusCode, 200, readOnlySubmit.body);
  const readOnlyMessage = readOnlySubmit.json<{ message: string }>().message;
  assert.equal(readOnlyMessage.includes(readOnly), true, 'the read-only token is handed back too');
  assert.match(readOnlyMessage, /copy_map\(id="trip", previewToken="cpt_[^"]+"\)/, 'a read-only share is pointed at copy_map instead');
  assert.equal(readOnlyMessage.includes('patch_map'), false, 'a read-only share is never told to patch_map');

  const ownerSubmit = await app.inject({ method: 'POST', url: '/api/maps/trip/submit', headers: bearer(map.spaceKey), payload: {} });
  assert.equal(ownerSubmit.statusCode, 200, ownerSubmit.body);
  const ownerMessage = ownerSubmit.json<{ message: string }>().message;
  assert.equal(ownerMessage.includes(PREVIEW_TOKEN_PREFIX), false, 'the owner\'s message carries no share token');
  assert.equal(ownerMessage.includes(SPACE_KEY_PREFIX), false, 'the owner\'s message carries no space key');

  // An owner can name their own map's previewToken alongside a valid owner
  // session in the same request (testing their own share link while signed
  // in, say). The grant for that one call is genuinely read-only, exactly as
  // README documents — but the caller is still the owner, and must not be
  // told their own map is a read-only link to copy from.
  const account = await register(app);
  const claimed = await app.inject({ method: 'POST', url: '/api/maps/trip/claim', headers: { ...account.headers, ...bearer(map.spaceKey) }, payload: {} });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const ownerWithToken = await app.inject({ method: 'POST', url: '/api/maps/trip/submit', headers: { ...account.headers, ...bearer(readOnly) }, payload: {} });
  assert.equal(ownerWithToken.statusCode, 200, ownerWithToken.body);
  assert.equal(ownerWithToken.json<{ access: MapAccess }>().access.kind, 'preview', 'this one call is still read-only, exactly as documented');
  const ownerWithTokenMessage = ownerWithToken.json<{ message: string }>().message;
  assert.equal(ownerWithTokenMessage.includes(readOnly), false, 'the owner\'s own token is never handed back as if to a different Agent');
  assert.equal(ownerWithTokenMessage.includes('分享凭据'), false);
});
