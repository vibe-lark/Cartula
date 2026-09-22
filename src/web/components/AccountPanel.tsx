import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Eye, EyeOff, Link2, LogOut, MoreHorizontal, Plus, Trash2, X } from 'lucide-react';
import {
  PASSWORD_RULE, authProblem,
  type AccessPort, type AccessState, type ApiKeyInfo, type AuthInput, type ClaimResult, type CreatedApiKey, type FavoriteMap, type HeldOwnerKey, type LibraryMap, type MapLibrary, type PreviewLink, type ShareLinkInfo,
} from '../adapters/access.js';
import { Modal } from './Modal.js';
import { CopyField } from './CopyField.js';
import { copyText } from './clipboard.js';

/**
 * Account, library and share surfaces.
 *
 * All of it is opened on purpose and nothing is shown before that: the header
 * carries icons, the panel carries the words. Rules the user has to satisfy —
 * the password ones above all — appear with the field they apply to, not as an
 * introduction to a form nobody has asked for yet.
 */

function problemText(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作失败，请稍后重试。';
}

/**
 * Sign in or register.
 *
 * The rules are stated where they are enforced, and only once the user has
 * chosen to register: they are a checklist for a field being filled in, not an
 * upfront warning. The server checks the same rules again — this only spares a
 * round trip and names what is missing.
 */
export function AuthForm({ mode, submitLabel, busy, onSubmit, onModeChange }: {
  mode: 'login' | 'register';
  submitLabel: string;
  busy?: boolean;
  onSubmit: (input: AuthInput) => Promise<void>;
  onModeChange: (mode: 'login' | 'register') => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const emailField = useRef<HTMLInputElement>(null);
  useEffect(() => { emailField.current?.focus(); }, [mode]);
  const working = busy || pending;
  return <form className="auth-form" onSubmit={event => {
    event.preventDefault();
    const input = { email, password, ...(mode === 'register' ? { passwordConfirm } : {}) };
    const problem = authProblem(input, mode);
    if (problem) { setError(problem); return; }
    setError(''); setPending(true);
    void onSubmit(input).catch(e => setError(problemText(e))).finally(() => setPending(false));
  }}>
    <label>邮箱<input ref={emailField} name="email" type="email" autoComplete="username" value={email} maxLength={254} required onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/></label>
    <label>密码<input name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} maxLength={128} required aria-describedby={mode === 'register' ? 'password-rule' : undefined} onChange={e => setPassword(e.target.value)}/></label>
    {mode === 'register' && <>
      <p className="field-hint" id="password-rule">{PASSWORD_RULE}</p>
      <label>确认密码<input name="passwordConfirm" type="password" autoComplete="new-password" value={passwordConfirm} maxLength={128} required onChange={e => setPasswordConfirm(e.target.value)}/></label>
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="form-actions">
      <button type="button" className="button quiet compact" disabled={working} onClick={() => { setError(''); onModeChange(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? '没有账号，去注册' : '已有账号，去登录'}</button>
      <button type="submit" className="button primary" disabled={working}>{working ? '正在处理…' : submitLabel}</button>
    </div>
  </form>;
}

/**
 * The ⋯ menu a library row carries.
 *
 * Same contract as the top bar's menus — outside pointer or a choice closes it —
 * minus the Escape key, which belongs to the panel this lives in: one Escape
 * closing the whole account panel is what someone pressing it expects, and two
 * handlers racing for it would make which one wins an accident of mount order.
 */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [open]);
  return <div className="row-menu" ref={ref}>
    <button type="button" className="icon-button" aria-label={label} aria-expanded={open} title={label} onClick={() => setOpen(value => !value)}><MoreHorizontal size={14}/></button>
    {open && <div className="dropdown row-menu-dropdown" role="menu"
      onClick={event => { if ((event.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false); }}>{children}</div>}
  </div>;
}

/**
 * A list of maps, each with the actions that apply to it.
 *
 * The actions sit behind ⋯ rather than on the row: deleting a map is next to
 * opening it, and a delete icon one pixel from the title is a click nobody meant
 * to make. Favorites and own maps differ in what they offer — removing a
 * favorite drops a reference, deleting a map destroys the thing itself — so they
 * are passed in separately rather than inferred from the row.
 */
function LibraryList({ maps, onRemove, onDelete, onCopyLink }: {
  maps: (LibraryMap | FavoriteMap)[];
  /** Drop this favorite. The map itself is somebody else's and stays. */
  onRemove?: (id: string) => void;
  /** Destroy this map. Asks first — see `DeleteMapDialog`. */
  onDelete?: (map: LibraryMap) => void;
  onCopyLink?: (map: LibraryMap | FavoriteMap) => void;
}) {
  if (!maps.length) return <p className="panel-empty">这里还没有地图。</p>;
  return <ul className="library-list">{maps.map(map => {
    const available = 'available' in map ? map.available : true;
    return <li key={map.id}>
      {available
        ? <a href={map.url}>{map.title}<small>v{map.version} · {map.updatedAt.slice(0, 10)}</small></a>
        : <span className="library-gone">{map.title}<small>分享已停用</small></span>}
      <RowMenu label={`${map.title} 的操作`}>
        <div className="dropdown-title">{map.title}</div>
        {available && <a role="menuitem" href={map.url}><ExternalLink size={14}/><span>打开</span></a>}
        {onCopyLink && available && <button type="button" role="menuitem" onClick={() => onCopyLink(map)}><Link2 size={14}/><span>复制链接<small aria-hidden="true">不含密钥</small></span></button>}
        {onRemove && <button type="button" role="menuitem" onClick={() => onRemove(map.id)}><X size={14}/><span>移除收藏</span></button>}
        {onDelete && <button type="button" role="menuitem" className="danger" onClick={() => onDelete(map)}><Trash2 size={14}/><span>删除地图<small aria-hidden="true">不可恢复</small></span></button>}
      </RowMenu>
    </li>;
  })}</ul>;
}

/**
 * The question asked before a map is destroyed.
 *
 * It names what goes beyond the map — the history, the links other people are
 * holding — because that is the part nobody has in mind when they click 删除,
 * and it is the part that cannot be undone by making the map again.
 */
function DeleteMapDialog({ map, busy, onConfirm, onClose }: { map: LibraryMap; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Modal title="删除地图" onClose={onClose}>
    <p className="dialog-description">
      「{map.title}」的全部历史版本会一起删除，这张地图的分享链接立刻失效，别人基于分享做的收藏也会消失。空间密钥之后打不开它，此操作不可恢复。
    </p>
    <div className="form-actions">
      <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="button destructive" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '删除地图'}</button>
    </div>
  </Modal>;
}

/**
 * A value that must be deliberately revealed, with the one action it needs.
 *
 * The value it copies is already on screen above it — a masked key that was
 * revealed, the config snippet — so a host that refuses the clipboard entirely
 * costs a manual selection rather than the value itself.
 */
function CopyButton({ label, value, onError }: { label: string; value: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [value]);
  return <button type="button" className="button primary compact" onClick={() => {
    void copyText(value).then(result => {
      if (result === 'unavailable') { onError('这个环境不允许自动复制，请手动选中上面的内容复制。'); return; }
      setCopied(true);
    });
  }}>{copied ? '已复制' : label}</button>;
}

/** csk_abcd…wxyz — enough to recognise the key, not enough to use it. */
function maskKey(key: string) {
  return key.length <= 14 ? '•'.repeat(key.length) : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * The MCP client entry, in the shape a config file wants it.
 *
 * The origin is read off the page rather than compiled in: the same bundle is
 * served by every deployment, and a hardcoded host would hand out a snippet
 * pointing at somebody else's server.
 */
function mcpSnippet(origin: string, apiKey?: string) {
  return JSON.stringify({
    mcpServers: {
      cartula: {
        type: 'http',
        url: `${origin}/mcp`,
        headers: { Authorization: `Bearer ${apiKey || '<API_KEY>'}` },
      },
    },
  }, null, 2);
}

/** One credential the MCP config could carry, and what this page knows of it. */
interface Credential {
  id: string;
  name: string;
  /** Recognisable, unusable — what is on screen until a reveal is asked for. */
  hint: string;
  /** The key itself, when this page is holding it. Absent is a real state. */
  secret?: string;
  meta?: string;
  /** Only an account API key can be destroyed from here. */
  removable?: boolean;
}

/**
 * Every credential this page can hand to an MCP client, and the one config
 * snippet they go into.
 *
 * This was two sections — a space key one and an API key one — and each carried
 * its own copy of the endpoint, the instructions and the JSON. That is worse
 * than repetitive: both told you what to put in `Authorization`, they named
 * different things, and neither said the other existed. So the credentials are a
 * list, one is selected, and the snippet is the selected one's. Both kinds are
 * valid bearers — the server tells them apart by digest, never by prefix.
 *
 * Held, never fetched. The server returns a key exactly once, in the response
 * that mints it, and no endpoint recovers one. So a key from an earlier session
 * can be named, dated and deleted here but not shown or copied, and its row says
 * so rather than offering a reveal that would come up empty.
 */
function CredentialsSection({ port, held, claimed, owner, signedIn, onError }: {
  port: AccessPort;
  held?: HeldOwnerKey;
  claimed: boolean;
  /** Whether this view owns the open map, which is what a space key would be for. */
  owner: boolean;
  signedIn: boolean;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ApiKeyInfo[]>();
  /** Plaintext for keys this session minted. Lost with the panel, as promised. */
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<string>();
  const [revealed, setRevealed] = useState<string>();
  const [busy, setBusy] = useState(false);
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const rows: Credential[] = [
    ...(held ? [{
      id: 'space',
      name: held.scope === 'space' ? '空间密钥' : '这张地图的编辑密钥',
      hint: maskKey(held.key), secret: held.key,
      meta: held.scope === 'space' ? 'spaceKey' : 'editKey',
    }] : []),
    ...(keys ?? []).map(key => ({
      id: key.id, name: key.name, hint: key.hint,
      ...(secrets[key.id] ? { secret: secrets[key.id] } : {}),
      meta: `API Key · ${key.createdAt.slice(0, 10)}`, removable: true,
    })),
  ];
  const current = rows.find(row => row.id === chosen) ?? rows[0];
  const snippet = mcpSnippet(origin, current?.secret);
  async function load() {
    if (!port.listApiKeys || !signedIn) return;
    setBusy(true);
    try { setKeys(await port.listApiKeys()); }
    catch (e) { onError(problemText(e)); }
    finally { setBusy(false); }
  }
  return <>
    {/* Every open starts masked: revealing is the action, and a reveal that
        outlived the collapse would put the key back on screen with no click. */}
    <button type="button" className="panel-entry" aria-expanded={open} onClick={() => {
      const next = !open;
      setOpen(next);
      setRevealed(undefined);
      if (next && keys === undefined) void load();
    }}>密钥与 MCP 接入</button>
    {open && <div className="space-key">
      <p className="field-hint">
        端点 <code>{origin}/mcp</code>，MCP Streamable HTTP。配置里的 <code>Authorization</code> 就是下面选中的这把密钥，宿主的配置界面通常把它叫作 API Key。
      </p>
      {busy && keys === undefined && signedIn && <p className="panel-empty">正在读取…</p>}
      {rows.length > 0 && <ul className="key-list">{rows.map(row => {
        const showing = revealed === row.id && row.secret;
        return <li key={row.id}>
          <button type="button" className="key-row" aria-pressed={row.id === current?.id} onClick={() => { setChosen(row.id); setRevealed(undefined); }}>
            <span className="key-name">{row.name}{row.meta && <small aria-hidden="true">{row.meta}</small>}</span>
            <code aria-label={`${row.name}${showing ? '' : '（已遮蔽）'}`}>{showing ? row.secret : row.hint}</code>
          </button>
          {row.secret && <button type="button" className="icon-button" aria-label={`${showing ? '隐藏' : '显示'} ${row.name}`} title={showing ? '隐藏' : '显示'}
            onClick={() => setRevealed(value => value === row.id ? undefined : row.id)}>{showing ? <EyeOff size={14}/> : <Eye size={14}/>}</button>}
          {row.removable && port.revokeApiKey && <button type="button" className="icon-button" aria-label={`删除 ${row.name}`} title="删除" onClick={() => {
            void port.revokeApiKey!(row.id).then(() => {
              setKeys(list => list?.filter(item => item.id !== row.id));
              setSecrets(({ [row.id]: _gone, ...rest }) => rest);
              if (revealed === row.id) setRevealed(undefined);
            }).catch(e => onError(problemText(e)));
          }}><Trash2 size={14}/></button>}
        </li>;
      })}</ul>}
      {/* Each note belongs to the row it is about, and only the selected row has
          one: three warnings stacked above a list nobody has chosen from yet is
          how the old version managed to be both crowded and unclear. */}
      {current?.id === 'space' && held && <>
        <p className="space-key-warn">这把密钥能编辑{held.scope === 'space' ? '这个空间里的每一张地图' : '这张地图'}，不是分享链接——只读链接请点顶栏的「分享」生成。</p>
        {held.scope === 'space'
          ? <p className="field-hint">也可以不写进配置文件：直接把它交给 Agent，每个工具都按次接收 <code>spaceKey</code> 参数；<code>list_maps({'{spaceKey}'})</code> 能列出同一空间的全部地图。</p>
          : <p className="field-hint">这是旧地图自己的 <code>editKey</code>，只对这张图有效。要一个能装多张图的空间，让 Agent 调用 <code>create_space</code>。</p>}
        {claimed && <p className="field-hint">这个空间已经保存到账号。密钥没有失效，Agent 可以继续使用。</p>}
      </>}
      {current && current.id !== 'space' && (current.secret
        ? <p className="space-key-warn">请立即复制。关闭这个面板后就看不到完整密钥了，服务端只存摘要。</p>
        : <p className="field-hint">这把密钥只在创建时显示过一次，这里只能删除它。配置里请填当时保存下来的那一串，或者新建一把。</p>)}
      {signedIn && keys?.length === 0 && <p className="panel-empty">还没有 API Key。</p>}
      {/* Owner without a key in hand: said plainly, because the honest answers
          are "ask the Agent that has it" and "mint one here" — not a recovery
          entry the server could not honour anyway. */}
      {owner && !held && <p className="field-hint">
        这个浏览器里没有这个空间的密钥{claimed ? '（空间已保存到账号，现在授权这个页面的是登录状态）' : ''}。
        空间密钥只在创建时返回一次，没有找回入口——它还在当初创建地图的 Agent 手里；{signedIn ? '也可以直接用下面的 API Key 接入，它授权这个账号名下的全部地图。' : '或者让 Agent 调用 create_space 新建一个空间并保存好返回的密钥。'}
      </p>}
      {signedIn && port.createApiKey && <div className="form-actions">
        <button type="button" className="button compact" disabled={busy} onClick={() => {
          setBusy(true);
          void port.createApiKey!('MCP').then(key => {
            setKeys(list => [key, ...(list ?? []).filter(item => item.id !== key.id)]);
            setSecrets(all => ({ ...all, [key.id]: key.apiKey }));
            // Straight into the snippet, revealed: creating one is asking for a
            // key to put somewhere, and this is the only moment it can be given.
            setChosen(key.id);
            setRevealed(key.id);
          }).catch(e => onError(problemText(e))).finally(() => setBusy(false));
        }}><Plus size={14}/>{busy ? '正在创建…' : '新建 API Key'}</button>
      </div>}
      <p className="space-key-label">接入 MCP 客户端</p>
      <pre className="space-key-code"><code>{snippet}</code></pre>
      <div className="form-actions">
        <CopyButton label="复制配置" value={snippet} onError={onError}/>
        {current?.secret && <CopyButton label="复制密钥" value={current.secret} onError={onError}/>}
      </div>
    </div>}
  </>;
}

/**
 * The one panel behind the account icon.
 *
 * Signed out it offers two words and nothing else; the form arrives when one of
 * them is chosen. Signed in, the lists load only when they are opened — a
 * header entry should not fetch a library nobody looked at.
 */
export function AccountPanel({ port, state, pending, initial, onClose, onResume }: {
  port: AccessPort;
  state: AccessState;
  /** What the user was doing when sign-in turned out to be required. */
  pending?: string;
  /**
   * Open straight onto one of the forms. Set where the entry that led here was
   * already named 登录 — clicking it must be the sign-in, not another menu
   * offering it.
   */
  initial?: 'login' | 'register';
  onClose: () => void;
  onResume?: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'register' | null>(initial ?? null);
  const [open, setOpen] = useState<'maps' | 'favorites' | null>(null);
  const [library, setLibrary] = useState<MapLibrary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** The map a delete was asked about, held until the question is answered. */
  const [condemned, setCondemned] = useState<LibraryMap>();
  const [deleting, setDeleting] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const user = state.user;
  const owner = state.access?.kind === 'owner';
  const copyLink = (map: LibraryMap | FavoriteMap) => {
    setError('');
    void copyText(map.url).then(result => {
      if (result === 'unavailable') { setError('这个环境不允许自动复制，请打开地图后从地址栏复制。'); return; }
      setNotice('已复制链接。');
    });
  };
  useEffect(() => { void port.refresh().catch(() => undefined); }, [port]);
  // Once, on open. Re-focusing on every render would pull the caret out of
  // whichever field is being filled in.
  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function load(section: 'maps' | 'favorites') {
    if (open === section) { setOpen(null); return; }
    setOpen(section); setError(''); setNotice('');
    if (library || !port.library) return;
    setBusy(true);
    try { setLibrary(await port.library()); }
    catch (e) { setError(problemText(e)); }
    finally { setBusy(false); }
  }
  return <section className="access-panel" role="dialog" aria-label="账号" aria-modal="false" ref={panel} tabIndex={-1}>
    <div className="dialog-heading">
      <h2>账号</h2>
      <button className="icon-button" aria-label="关闭账号面板" onClick={onClose}><X size={17}/></button>
    </div>
    {/* Under the heading rather than at the foot of the panel: this scrolls, and
        an answer to "did the delete work" printed below the fold is not one. */}
    {notice && <p role="status" className="delivery-state info">{notice}</p>}
    {error && <p role="alert" className="form-error panel-error">{error}</p>}
    {user ? <>
      <p className="account-email" title={user.email}>{user.email}</p>
      <div className="panel-entries">
        <button type="button" className="panel-entry" aria-expanded={open === 'maps'} onClick={() => void load('maps')}>我的地图</button>
        {open === 'maps' && (busy ? <p className="panel-empty">正在读取…</p> : <LibraryList maps={library?.maps ?? []} onCopyLink={copyLink}
          onDelete={port.deleteMap && (map => { setError(''); setNotice(''); setCondemned(map); })}/>)}
        <button type="button" className="panel-entry" aria-expanded={open === 'favorites'} onClick={() => void load('favorites')}>收藏</button>
        {open === 'favorites' && (busy ? <p className="panel-empty">正在读取…</p> : <LibraryList maps={library?.favorites ?? []} onCopyLink={copyLink} onRemove={port.unfavorite && (id => {
          setError('');
          void port.unfavorite!(id)
            .then(() => setLibrary(current => current && { ...current, favorites: current.favorites.filter(item => item.id !== id) }))
            .catch(e => setError(problemText(e)));
        })}/>)}
        <button type="button" className="panel-entry" disabled={busy} onClick={() => {
          setBusy(true); setError('');
          void port.logout?.().then(() => { setLibrary(undefined); setOpen(null); setMode(null); }).catch(e => setError(problemText(e))).finally(() => setBusy(false));
        }}><LogOut size={14} aria-hidden="true"/>退出登录</button>
      </div>
    </> : mode ? <>
      {pending && <p className="dialog-description">{pending}</p>}
      <AuthForm mode={mode} submitLabel={mode === 'login' ? '登录' : '注册'} onModeChange={setMode} onSubmit={async input => {
        await (mode === 'login' ? port.login?.(input) : port.register?.(input));
        onResume?.();
      }}/>
    </> : <>
      {pending && <p className="dialog-description">{pending}</p>}
      <div className="form-actions">
        <button type="button" className="button primary" onClick={() => setMode('login')}>登录</button>
        <button type="button" className="button" onClick={() => setMode('register')}>注册</button>
      </div>
    </>}
    {/* Asked of the port at render time for the same reason `capabilities` is:
        the adapter learns what this page holds while it runs. A space key is
        owner-only — a preview visitor and a legacy public map never have one,
        their `kind` is not `owner` — while account API keys need a session, so
        the section appears for either and lists whichever exist. A transport
        that cannot answer the question is not asked it, which is what keeps an
        embedded frame out of this entirely. */}
    {((owner && port.ownerKey) || (user && port.listApiKeys)) && <div className="panel-entries panel-section">
      <CredentialsSection port={port} owner={owner} signedIn={Boolean(user)}
        held={owner ? port.ownerKey?.() : undefined} claimed={Boolean(state.access?.claimed)} onError={setError}/>
    </div>}
    {condemned && <DeleteMapDialog map={condemned} busy={deleting}
      onClose={() => { if (!deleting) setCondemned(undefined); }}
      onConfirm={() => {
        if (!port.deleteMap) return;
        setDeleting(true); setError('');
        void port.deleteMap(condemned.id).then(() => {
          setLibrary(current => current && { ...current, maps: current.maps.filter(item => item.id !== condemned.id) });
          setNotice(`已删除「${condemned.title}」。`);
          setCondemned(undefined);
        }).catch(e => { setError(problemText(e)); setCondemned(undefined); }).finally(() => setDeleting(false));
      }}/>}
  </section>;
}

/**
 * What to paste into the conversation with whoever receives this link: the
 * one paragraph their own Agent needs to act on this map using nothing but
 * the token, without ever touching a space key.
 */
function agentHandoffText(mapId: string, link: PreviewLink): string {
  const call = `id="${mapId}", previewToken="${link.previewToken}"`;
  const action = link.canWrite ? `，也可以调用 patch_map(${call}, …) 修改它` : '；这个链接只读，不能修改这张地图';
  return `Cartula 地图分享\n地图 id：${mapId}\n分享凭据 previewToken：${link.previewToken}\n分享地址：${link.previewUrl}\n请调用 get_map(${call}) 读取这张地图${action}。`;
}

/**
 * The links this map is already open through.
 *
 * There used to be a 停用全部分享 button and nothing to say what it would stop.
 * The rows are what that button is about: one line each, dated, read-only or
 * editable, with its own 停用.
 *
 * No addresses. The token is returned once, in the response that mints it, and
 * the server keeps only a digest — so a link from an earlier session can be
 * dated and revoked here but never shown again, and the header says so instead
 * of offering a reveal that would come up empty.
 */
function ShareList({ links, justMinted, busy, onRevoke }: {
  links: ShareLinkInfo[];
  /** The one minted in this dialog, whose address is still on screen above. */
  justMinted?: string;
  busy: boolean;
  onRevoke: (id: string) => void;
}) {
  if (!links.length) return <p className="panel-empty">还没有分享链接。</p>;
  /**
   * When this link was minted, on the reader's own clock and to the minute.
   *
   * The server stores UTC, and minting two links in one afternoon is the normal
   * case — a row printed as a bare date, in another timezone, is one the person
   * deciding which link to stop cannot match to anything they did.
   */
  const when = (link: ShareLinkInfo) => {
    const at = new Date(link.createdAt);
    return Number.isNaN(at.getTime())
      ? link.createdAt.slice(0, 16).replace('T', ' ')
      : at.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  return <ul className="share-list">{links.map(link => <li key={link.id}>
    <span className="share-kind">{link.canWrite ? '可编辑' : '只读'}</span>
    <span className="share-meta">{when(link)} 生成{link.id === justMinted ? ' · 刚生成' : ''}</span>
    <button type="button" className="icon-button" disabled={busy} title="停用"
      aria-label={`停用 ${when(link)} 生成的${link.canWrite ? '可编辑' : '只读'}分享`}
      onClick={() => onRevoke(link.id)}><Trash2 size={14}/></button>
  </li>)}</ul>;
}

/**
 * Sharing, and only sharing.
 *
 * The link is minted when it is asked for, because every generated link is one
 * more way in that stays open until it is revoked. The owner address is not
 * shown here at all: it is not a share, it is the key to the whole space.
 */
export function ShareDialog({ port, mapId, onClose }: { port: AccessPort; mapId: string; onClose: () => void }) {
  const [link, setLink] = useState<PreviewLink>();
  const [canWrite, setCanWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<ShareLinkInfo[]>();
  // Listing is the dialog's own reason to open; a transport that cannot list
  // (an older host build) still shares, and simply shows no list.
  useEffect(() => {
    if (!port.listShares) return;
    void port.listShares().then(setLinks).catch(e => setError(problemText(e)));
  }, [port]);
  function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    void action()
      .then(() => port.listShares?.().then(setLinks))
      .catch(async e => {
        setError(problemText(e));
        // A lost response may already have created the share. Show the live
        // list even on failure so it can be inspected or revoked.
        await port.listShares?.().then(setLinks).catch(() => undefined);
      })
      .finally(() => setBusy(false));
  }
  return <Modal title="分享地图" onClose={onClose}>
    <p className="dialog-description">链接只打开这一张地图，随时可以停用。</p>
    <label className="share-permission">
      {/* Switching the checkbox drops the link already on screen: it was minted
          under the other setting, and a read-only link sitting under the words
          「允许对方编辑」 is a promise the token does not keep. */}
      <input type="checkbox" checked={canWrite} disabled={busy} onChange={event => { setCanWrite(event.currentTarget.checked); setLink(undefined); }}/>
      <span>允许对方编辑
        <small>{canWrite ? '对方可以改这张地图，不能删除或再分享。' : '对方只能查看和导出。'}</small>
      </span>
    </label>
    {link && <CopyField label="分享链接" value={link.previewUrl}/>}
    {/* The link alone opens nothing for an Agent that only reads tool arguments — it
        needs the previewToken named explicitly, which is what this hands over. */}
    {link && <CopyField label="分享给 Agent" value={agentHandoffText(mapId, link)} rows={3}/>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {links && <>
      <p className="space-key-label">已生成的链接<small>地址只在生成时显示一次</small></p>
      <ShareList links={links} justMinted={link?.id} busy={busy} onRevoke={id => run(async () => {
        await port.revokeShare?.(id);
        if (id === link?.id) setLink(undefined);
      })}/>
    </>}
    <div className="form-actions">
      <button type="button" className="button quiet danger" disabled={busy || links?.length === 0}
        onClick={() => run(async () => { await port.revokeShare?.(); setLink(undefined); })}>停用全部分享</button>
      <button type="button" className="button primary" disabled={busy} onClick={() => run(async () => {
        const created = await port.share?.(canWrite);
        if (created) setLink(created);
      })}>{link ? '再生成一条' : canWrite ? '生成可编辑链接' : '生成只读链接'}</button>
    </div>
  </Modal>;
}

/**
 * Save this space to an account.
 *
 * The space is the unit, not the map, so the count is stated before the action
 * rather than discovered after it — and only when there is more than one map to
 * be surprised by. The key keeps working afterwards: whoever is still holding
 * it, agent included, is unaffected.
 */
export function ClaimDialog({ port, state, onClose, onClaimed }: {
  port: AccessPort;
  state: AccessState;
  onClose: () => void;
  onClaimed: (result: ClaimResult) => void;
}) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const count = state.access?.spaceMapCount ?? 1;
  async function claim() {
    setBusy(true); setError('');
    try {
      const result = await port.claim?.();
      if (result) onClaimed(result);
    } catch (e) { setError(problemText(e)); }
    finally { setBusy(false); }
  }
  return <Modal title="保存到账号" onClose={onClose}>
    <p className="dialog-description">
      {count > 1 ? `这个空间里的 ${count} 张地图会一起保存到账号。` : '这张地图会保存到账号。'}
      原来的链接和密钥仍然有效，Agent 可以继续使用。
    </p>
    {state.user ? <>
      <p className="account-email" title={state.user.email}>{state.user.email}</p>
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="form-actions"><button type="button" className="button primary" disabled={busy} onClick={() => void claim()}>{busy ? '正在保存…' : '保存到账号'}</button></div>
    </> : <>
      {/* Registering is part of this action, so it finishes it: the map, the
          space and everything typed stay exactly where they were. */}
      <AuthForm mode={mode} submitLabel={mode === 'login' ? '登录并保存' : '注册并保存'} busy={busy} onModeChange={setMode} onSubmit={async input => {
        await (mode === 'login' ? port.login?.(input) : port.register?.(input));
        await claim();
      }}/>
      {error && <p role="alert" className="form-error">{error}</p>}
    </>}
  </Modal>;
}

/** Where a copy ended up, when the view cannot simply switch to it. */
export function CopyDialog({ title, url, onOpen, onClose }: { title: string; url: string; onOpen?: () => void; onClose: () => void }) {
  return <Modal title="已创建副本" onClose={onClose}>
    <p className="dialog-description">「{title}」是一张属于你的新地图，可以自由编辑。</p>
    <CopyField label="副本链接" value={url}/>
    {onOpen && <div className="form-actions"><button type="button" className="button primary" onClick={onOpen}><ExternalLink size={15}/>打开副本</button></div>}
  </Modal>;
}
