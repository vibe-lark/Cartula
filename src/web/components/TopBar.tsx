import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, CircleUserRound, CopyPlus, ExternalLink, FileJson, Download, History, Info, KeyRound, Languages, Maximize2, MessageSquareText, MoreHorizontal, Palette, Plus, Redo2, Save, Share2, Sparkles, Star, Tags, Undo2, Upload, Settings2 } from 'lucide-react';
import type { LegLabelMode, RouteColorMode } from './legs.js';
import type { MapLanguage, MapStyle } from './preferences.js';

/**
 * One icon button in the top bar that opens a small dropdown. Closes on
 * outside pointer, Escape, or selection — the same contract the "更多" menu
 * always had, now shared by every switch in the bar.
 */
function TopMenu({ icon, label, active = false, badge, children, align = 'right' }: {
  icon: React.ElementType; label: string; active?: boolean; badge?: number;
  children: ReactNode; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onPointer = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointer); };
  }, [open]);
  const Icon = icon;
  return <div className="top-menu" ref={ref}>
    <button type="button" className={`icon-button top-menu-button ${active ? 'active' : ''}`} aria-label={label} aria-expanded={open} title={label} onClick={() => setOpen(v => !v)}>
      <Icon size={16}/>
      {badge !== undefined && badge > 0 && <span className="info-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
    </button>
    {open && <div className={`dropdown top-menu-dropdown ${align === 'left' ? 'align-left' : ''}`} role="menu"
      onClick={e => { if ((e.target as HTMLElement).closest('[role="menuitemradio"], [role="menuitem"]')) setOpen(false); }}>{children}</div>}
  </div>;
}

function MenuItem({ checked, label, hint, onClick }: { checked?: boolean; label: string; hint?: string; onClick: () => void }) {
  return <button type="button" role="menuitemradio" aria-checked={Boolean(checked)} onClick={onClick}>
    <span className="menu-check">{checked && <Check size={13}/>}</span>
    <span>{label}{hint && <small aria-hidden="true">{hint}</small>}</span>
  </button>;
}

export interface TopBarProps {
  title: string;
  saveLabel: string;
  connection: 'live' | 'polling' | 'offline' | 'connecting';
  mapStyle: MapStyle;
  onMapStyle: (style: MapStyle) => void;
  colorMode: RouteColorMode;
  onColorMode: (mode: RouteColorMode) => void;
  language: MapLanguage;
  onLanguage: (language: MapLanguage) => void;
  /** Basemap languages only do something with a styled basemap. */
  languageAvailable: boolean;
  legMode: LegLabelMode;
  onLegMode: (mode: LegLabelMode) => void;
  /** Legend card content, shown when the 图例 menu is open. */
  legend: ReactNode;
  editable: boolean;
  busy: boolean;
  pending: number;
  changesLabel: string;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExpand?: () => void;
  onShare?: () => void;
  canShare?: boolean;
  onSaveToAccount?: () => void;
  onFavorite?: () => void;
  favorited?: boolean;
  onCopy?: () => void;
  onAccount?: () => void;
  accountOpen?: boolean;
  accountEmail?: string;
  onOpenStandalone?: () => void;
  onContinue: () => void;
  onChanges: () => void;
  onExport: (format: 'json' | 'html') => void;
  onImport: () => void;
  onAccess?: () => void;
  onNew: () => void;
  /** Basemap credits and third-party licences — off the map, one press away. */
  onCredits: () => void;
  onSettings: () => void;
}

export default function TopBar(props: TopBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    const onPointer = (e: PointerEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onPointer); };
  }, [moreOpen]);
  return <header className="topbar">
    <a className="brand" href="/" title={props.title} aria-label={`Cartula · ${props.title}`}><svg width="28" height="28" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="10" fill="currentColor"/><path d="m8 22 5-13 5 13 6-12M10 17h11" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="24" cy="10" r="2.4" fill="#dbec99"/></svg><span>Cartula</span></a>
    <h1 className="map-title">{props.title}</h1>
    <div className={`save-state ${props.connection}`} role="status"><i/>{props.saveLabel}</div>
    <div className="topbar-history">
      <button type="button" className="icon-button" aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={!props.editable || props.busy || !props.canUndo} onClick={props.onUndo}><Undo2 size={16}/></button>
      <button type="button" className="icon-button" aria-label="重做" title="重做 (Ctrl+Y)" disabled={!props.editable || props.busy || !props.canRedo} onClick={props.onRedo}><Redo2 size={16}/></button>
      <button type="button" className="button compact quiet topbar-version-button" aria-label={props.changesLabel} title="查看最近修改" onClick={props.onChanges}>
        <History size={14}/><span>{props.changesLabel}</span>
      </button>
    </div>
    <div className="topbar-menus">
      <TopMenu icon={Palette} label="底图色彩">
        <div className="dropdown-title">底图色彩</div>
        <MenuItem checked={props.mapStyle === 'positron'} label="简洁（默认）" hint="浅白素雅，清晰舒适" onClick={() => props.onMapStyle('positron')}/>
        <MenuItem checked={props.mapStyle === 'liberty'} label="彩色" hint="全要素详细地图" onClick={() => props.onMapStyle('liberty')}/>
        <MenuItem checked={props.mapStyle === 'bright'} label="明亮" hint="高对比明快风格" onClick={() => props.onMapStyle('bright')}/>
        <MenuItem checked={props.mapStyle === 'dark'} label="深色" hint="夜间低对比度" onClick={() => props.onMapStyle('dark')}/>
      </TopMenu>
      {props.languageAvailable && <TopMenu icon={Languages} label="地名语言">
        <div className="dropdown-title">地名语言</div>
        <MenuItem checked={props.language === 'zh'} label="简体中文" hint="优先简体，缺少时显示原生名称" onClick={() => props.onLanguage('zh')}/>
        <MenuItem checked={props.language === 'zh-Hant'} label="繁体中文" hint="优先繁体，缺少时显示原生名称" onClick={() => props.onLanguage('zh-Hant')}/>
        <MenuItem checked={props.language === 'en'} label="English" hint="Prefer English labels" onClick={() => props.onLanguage('en')}/>
        <MenuItem checked={props.language === 'local'} label="当地语言" hint="显示当地原生名称" onClick={() => props.onLanguage('local')}/>
      </TopMenu>}
      <TopMenu icon={Tags} label="图例">
        <div className="dropdown-title">图例</div>
        {props.legend}
      </TopMenu>
      <TopMenu icon={MessageSquareText} label="路段标注">
        <div className="dropdown-title">路段标注</div>
        <MenuItem checked={props.legMode === 'auto'} label="自动" hint="地图拥挤时隐藏部分标注" onClick={() => props.onLegMode('auto')}/>
        <MenuItem checked={props.legMode === 'all'} label="全部" hint="显示所有能放下的标注" onClick={() => props.onLegMode('all')}/>
        <MenuItem checked={props.legMode === 'off'} label="隐藏" hint="隐藏路段标注" onClick={() => props.onLegMode('off')}/>
      </TopMenu>
    </div>
    <div className="header-actions">
      {props.onExpand && <button className="icon-button" aria-label="展开" title="展开为全屏" onClick={props.onExpand}><Maximize2 size={16}/></button>}
      {props.canShare !== false && <button className="icon-button" aria-label="分享" title="分享地图" onClick={props.onShare}><Share2 size={16}/></button>}
      {props.onFavorite && <button className="icon-button" aria-pressed={Boolean(props.favorited)} aria-label={props.favorited ? '已收藏' : '收藏'} title={props.favorited ? '已收藏这张地图' : '收藏这张地图'} onClick={props.onFavorite}><Star size={16} {...(props.favorited ? { fill: 'currentColor' } : {})}/></button>}
      {props.onCopy && !props.editable && <button className="icon-button" aria-label="复制地图" title="复制一份可以自由编辑的地图" onClick={props.onCopy}><CopyPlus size={16}/></button>}
      <div className="export-wrap" ref={moreRef}>
        <button className="button quiet" aria-expanded={moreOpen} aria-label="更多" onClick={() => setMoreOpen(v => !v)}><MoreHorizontal size={16}/></button>
        {moreOpen && <div className="dropdown"><div className="dropdown-title">{props.title}</div>
          <button aria-label="按这些修改继续规划" onClick={() => { setMoreOpen(false); props.onContinue(); }}><Sparkles size={16}/><span>按这些修改继续规划<small aria-hidden="true">{props.pending > 0 ? `${props.pending} 条修改还没交给 Agent` : '把本轮修改交给 Agent'}</small></span></button>
          <button onClick={() => { setMoreOpen(false); props.onChanges(); }}><Sparkles size={16}/><span>最近修改</span></button>
          <button aria-label="导出 JSON" onClick={() => { setMoreOpen(false); props.onExport('json'); }}><FileJson size={16}/><span>导出 JSON<small aria-hidden="true">交给 Agent 继续规划</small></span></button>
          <button aria-label="离线 HTML" onClick={() => { setMoreOpen(false); props.onExport('html'); }}><Download size={16}/><span>离线 HTML<small aria-hidden="true">保存地图，断网也可编辑</small></span></button>
          <button onClick={() => { setMoreOpen(false); props.onImport(); }} disabled={!props.editable || props.busy}><Upload size={16}/><span>导入数据</span></button>
          {props.onAccess && <button aria-label="启用编辑" onClick={() => { setMoreOpen(false); props.onAccess!(); }}><KeyRound size={16}/><span>启用编辑<small aria-hidden="true">粘贴这张地图的编辑链接或密钥</small></span></button>}
          <button className="new-map" onClick={() => { setMoreOpen(false); props.onNew(); }}><Plus size={16}/><span>新地图</span></button>
          <button disabled={!props.editable || props.busy} onClick={() => { setMoreOpen(false); props.onSettings(); }}><Settings2 size={16}/><span>地图设置</span></button>
          {/* The map's corner used to carry this. It is here instead — findable
              by anyone looking for it, and off the geometry for everyone else. */}
          <button aria-label="地图数据与开源声明" onClick={() => { setMoreOpen(false); props.onCredits(); }}><Info size={16}/><span>地图数据与开源声明<small aria-hidden="true">底图来源、路线来源与开源许可</small></span></button>
        </div>}
      </div>
      {/* Everything above acts on this document; what follows acts on the
          account behind it. The divider keeps a stray click on 账号 from
          reading as one more map action, and the account entry sits last
          because that is where every host puts it. */}
      <div className="header-system">
        {props.onSaveToAccount && <button className="icon-button" aria-label="保存到账号" title="把这个空间保存到账号" onClick={props.onSaveToAccount}><Save size={16}/></button>}
        {props.onAccount && <button className="icon-button" aria-label={props.accountEmail ? `账号 · ${props.accountEmail}` : '账号'} title={props.accountEmail ?? '账号'} {...(props.accountOpen === undefined ? {} : { 'aria-expanded': props.accountOpen })} onClick={props.onAccount}><CircleUserRound size={17}/></button>}
        {/* No account entry in this host, so the way out to the browser — where
            an account does exist — takes the rightmost slot instead. */}
        {!props.onAccount && props.onOpenStandalone && <button className="icon-button"
          aria-label={props.onExpand ? '在浏览器中打开' : '在独立页面打开大画布'}
          title={props.onExpand ? '在浏览器中打开这张地图，可登录账号并收藏' : '当前宿主不支持全屏；在浏览器中打开可获得完整画布，也可登录账号并收藏'}
          onClick={props.onOpenStandalone}><ExternalLink size={16}/></button>}
      </div>
    </div>
  </header>;
}
