/** Public transport contracts. Never persist bearer credentials in map snapshots. */
export interface AccountUser { id: string; email: string }
export interface AccountSession { user: AccountUser | null }
export interface SpaceCredential { spaceId: string; spaceKey: string; claimed: boolean }
export interface MapAccess {
  /** `shared-edit` is a share that may write: one map, revocable, never an owner. */
  kind: 'owner' | 'shared-edit' | 'preview' | 'legacy-public';
  editable: boolean;
  canShare: boolean;
  canClaim: boolean;
  claimed: boolean;
  /** Owner-only context; preview responses omit both fields. */
  spaceId?: string;
  spaceMapCount?: number;
  /**
   * Who this caller is in the event log — a stable, non-secret id, never a
   * credential. Compare it against `SemanticEvent.author` to tell your own
   * edits from a collaborator's; two Agents on one map otherwise both read
   * `actor: 'agent'` and cannot separate themselves.
   */
  authorId?: string;
}
/**
 * One live share of one map, as its owner can still see it.
 *
 * No token: only the digest is stored, so a link that was minted in an earlier
 * session can be named, dated and revoked — never shown again. Any surface that
 * lists these has to say so rather than offer a reveal that would come up empty.
 */
export interface ShareLinkInfo { id: string; createdAt: string; canWrite: boolean }
/** The one response that still carries the token, so the link can be handed out. */
export interface PreviewLink extends ShareLinkInfo { previewToken: string; previewUrl: string }
export interface LibraryMap {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  url: string;
}
export interface FavoriteMap extends LibraryMap { available: boolean }
export interface MapLibrary { maps: LibraryMap[]; favorites: FavoriteMap[] }
export interface ClaimResult { access: MapAccess; claimedMapCount: number }
/** An account API key as the owner sees it after the secret has left the process. */
export interface ApiKeyInfo { id: string; name: string; hint: string; createdAt: string }
/** The one response that still carries the secret. */
export interface CreatedApiKey extends ApiKeyInfo { apiKey: string }
