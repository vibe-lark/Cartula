/**
 * The drawings on the landing page: a hero canvas that looks like the product,
 * and three interaction demos (layers, path editing, sharing).
 *
 * Everything here is schematic — hand-placed coordinates in a fixed viewBox,
 * not real geography — but the *behaviour* it shows is the product's: one
 * layer per agent, day shades inside a plan, a dragged stop that gets its road
 * re-solved, a share whose permission decides what the other side's agent may
 * call. Map marks are SVG; panels, cards and bubbles are HTML laid over the
 * SVG so text wraps and reads like the real chrome.
 *
 * Timelines are plain timers driven by `useSteps`. With `prefers-reduced-motion`
 * every demo renders its final frame at once and nothing loops.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bot, Check, Copy, Eye, EyeOff, LoaderCircle, Send, Sparkles } from 'lucide-react';
import { copyText } from './clipboard.js';

/* ------------------------------------------------------------------ */
/* Motion helpers                                                      */
/* ------------------------------------------------------------------ */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(query.matches);
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/**
 * The current step of a timeline: step `k` means `delays[0..k-1]` have
 * elapsed since the timeline (re)started. Disabled timelines sit on the last
 * step; `loopAfter` restarts from 0 that many ms after the start.
 */
function useSteps(delays: readonly number[], enabled: boolean, loopAfter?: number): number {
  const [step, setStep] = useState(enabled ? 0 : delays.length);
  useEffect(() => {
    if (!enabled) { setStep(delays.length); return; }
    let cancelled = false;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      setStep(0);
      delays.forEach((delay, index) => timers.push(setTimeout(() => { if (!cancelled) setStep(index + 1); }, delay)));
      if (loopAfter) timers.push(setTimeout(() => { if (!cancelled) { timers = []; run(); } }, loopAfter));
    };
    run();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [delays, enabled, loopAfter]);
  return step;
}

/* ------------------------------------------------------------------ */
/* Map primitives                                                      */
/* ------------------------------------------------------------------ */

const ROAD = '#e1e3e8';
const WATER = '#d7e4f4';
const BLOCK = '#eceef2';

/** A quiet basemap: a few roads, one river, a handful of blocks. */
function Basemap({ w, h }: { w: number; h: number }) {
  const x = (f: number) => (f * w).toFixed(1);
  const y = (f: number) => (f * h).toFixed(1);
  return <g aria-hidden="true">
    <rect width={w} height={h} fill="#f7f8fa" />
    <g fill={BLOCK}>
      <rect x={x(0.06)} y={y(0.12)} width={x(0.14)} height={y(0.16)} rx="3" />
      <rect x={x(0.72)} y={y(0.08)} width={x(0.18)} height={y(0.14)} rx="3" />
      <rect x={x(0.30)} y={y(0.70)} width={x(0.16)} height={y(0.18)} rx="3" />
      <rect x={x(0.80)} y={y(0.64)} width={x(0.12)} height={y(0.20)} rx="3" />
      <rect x={x(0.50)} y={y(0.36)} width={x(0.10)} height={y(0.10)} rx="3" />
    </g>
    <path d={`M${x(-0.02)} ${y(0.58)} C ${x(0.25)} ${y(0.50)}, ${x(0.40)} ${y(0.66)}, ${x(0.62)} ${y(0.60)} S ${x(0.90)} ${y(0.44)}, ${x(1.02)} ${y(0.50)}`} stroke={WATER} strokeWidth="9" fill="none" strokeLinecap="round" />
    <g stroke={ROAD} strokeWidth="1.5" fill="none">
      <path d={`M${x(-0.02)} ${y(0.22)} Q ${x(0.30)} ${y(0.16)} ${x(0.55)} ${y(0.24)} T ${x(1.02)} ${y(0.20)}`} />
      <path d={`M${x(-0.02)} ${y(0.40)} Q ${x(0.28)} ${y(0.34)} ${x(0.58)} ${y(0.42)} T ${x(1.02)} ${y(0.38)}`} />
      <path d={`M${x(-0.02)} ${y(0.82)} Q ${x(0.30)} ${y(0.76)} ${x(0.60)} ${y(0.84)} T ${x(1.02)} ${y(0.80)}`} />
      <path d={`M${x(0.22)} ${y(-0.02)} Q ${x(0.28)} ${y(0.35)} ${x(0.20)} ${y(0.62)} T ${x(0.26)} ${y(1.02)}`} />
      <path d={`M${x(0.60)} ${y(-0.02)} Q ${x(0.66)} ${y(0.36)} ${x(0.58)} ${y(0.64)} T ${x(0.64)} ${y(1.02)}`} />
      <path d={`M${x(0.86)} ${y(-0.02)} Q ${x(0.90)} ${y(0.30)} ${x(0.84)} ${y(0.60)} T ${x(0.88)} ${y(1.02)}`} />
    </g>
    <g fill="#d5d8de">
      {[[0.10, 0.08], [0.36, 0.30], [0.68, 0.14], [0.14, 0.72], [0.46, 0.56], [0.78, 0.76], [0.92, 0.30], [0.58, 0.90]].map(([fx, fy]) => (
        <circle key={`${fx}-${fy}`} cx={x(fx)} cy={y(fy)} r="2" />
      ))}
    </g>
  </g>;
}

/** A stop: a white disc with the day number, in the plan's colour. */
function Pin({ x, y, color, label, delay = 0, r = 11, name, nameSide = 'right', shift }: {
  x: number; y: number; color: string; label: string | number; delay?: number; r?: number;
  name?: string; nameSide?: 'left' | 'right' | 'top'; shift?: { dx: number; dy: number; lifted?: boolean };
}) {
  const inner: CSSProperties = shift ? { transform: `translate(${shift.dx}px, ${shift.dy}px)`, transition: 'transform 0.9s cubic-bezier(0.4, 0, 0.2, 1)' } : {};
  const labelPos = nameSide === 'left' ? { x: -(r + 6), y: 4, anchor: 'end' as const } : nameSide === 'top' ? { x: 0, y: -(r + 7), anchor: 'middle' as const } : { x: r + 6, y: 4, anchor: 'start' as const };
  return <g transform={`translate(${x} ${y})`}>
    <g style={inner}>
      <g className={`lp-pin${shift?.lifted ? ' lp-pin-lifted' : ''}`} style={{ animationDelay: `${delay}ms` }}>
        <circle r={r} fill="#fff" stroke={color} strokeWidth="2.5" />
        <text textAnchor="middle" dy="4" fontSize={r > 10 ? 11 : 10} fontWeight="600" fill={color}>{label}</text>
        {name && <text x={labelPos.x} y={labelPos.y} textAnchor={labelPos.anchor} fontSize="11" fontWeight="500" fill="#1f2329" stroke="#f7f8fa" strokeWidth="3" paintOrder="stroke">{name}</text>}
      </g>
    </g>
  </g>;
}

/** A candidate place: the teardrop used for `kind:"spots"` layers. */
function Spot({ x, y, color, delay = 0 }: { x: number; y: number; color: string; delay?: number }) {
  return <g transform={`translate(${x} ${y})`}>
    <g className="lp-pin lp-spot" style={{ animationDelay: `${delay}ms` }}>
      <path d="M0 2c-6.5-7-9-10.5-9-14a9 9 0 1 1 18 0c0 3.5-2.5 7-9 14z" fill={color} />
      <circle cy="-12" r="3.2" fill="#fff" />
    </g>
  </g>;
}

/** One leg of a route, drawn on as it appears. `pathLength=1` makes the dash trick independent of the geometry. */
function Leg({ d, color, delay = 0, width = 3.5, draw = true, dim = false }: { d: string; color: string; delay?: number; width?: number; draw?: boolean; dim?: boolean }) {
  return <path d={d} pathLength={draw ? 1 : undefined} className={`${draw ? 'lp-leg' : ''}${dim ? ' lp-leg-dim' : ''}`}
    style={{ animationDelay: `${delay}ms` }} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" />;
}

const PLAN_A = { base: '#2563eb', day1: '#2563eb', day2: '#6b9af7', day3: '#1e3fae' };
const PLAN_B = { base: '#e11d48', day1: '#e11d48', day2: '#f0668a' };
const SPOTS = '#16a34a';

/* ------------------------------------------------------------------ */
/* Hero canvas                                                         */
/* ------------------------------------------------------------------ */

/**
 * The product, drawn small: the demo map `/app` opens with (two routes north
 * through the Khingan ranges), its layer panel, an agent's note and the entry
 * that hands this round's edits back to the conversation.
 */
export function HeroCanvas() {
  const reduced = usePrefersReducedMotion();
  return <div className={`lp-frame${reduced ? ' lp-still' : ''}`} role="img" aria-label="Cartula 画布示意：两条路线分别是两个图层，停靠点按天着色，右上角是 Agent 的建议，右下角把本轮修改交回对话">
    <div className="lp-frame-top">
      <span className="lp-frame-brand"><span className="lp-frame-mark">C</span>大小兴安岭：两条北上路线</span>
      <span className="lp-frame-status"><span className="lp-dot lp-dot-ok" />改动已保存 · v3</span>
      <span className="lp-frame-actions"><span className="lp-frame-btn">导出</span><span className="lp-frame-btn lp-frame-btn-primary">分享</span></span>
    </div>
    <div className="lp-frame-body">
      <aside className="lp-frame-panel">
        <div className="lp-frame-panel-head">图层<span className="lp-count">3</span></div>
        {[
          { color: PLAN_A.base, name: '小兴安岭线', meta: '路线 · 4 站 · 5 天', on: true },
          { color: PLAN_B.base, name: '大兴安岭线', meta: '路线 · 3 站 · 6 天', on: true },
          { color: SPOTS, name: '候选景点', meta: '地点集 · 5 个', on: true },
        ].map(layer => (
          <div key={layer.name} className="lp-layer-row">
            <span className="lp-swatch" style={{ background: layer.color }} />
            <span className="lp-layer-text"><strong>{layer.name}</strong><small>{layer.meta}</small></span>
            <Eye size={13} className="lp-layer-eye" />
          </div>
        ))}
        <div className="lp-frame-panel-foot">比较全部 · WGS84</div>
      </aside>
      <div className="lp-frame-map">
        <svg viewBox="0 0 600 420" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <Basemap w={600} h={420} />
          {/* 小兴安岭线：哈尔滨 → 伊春 → 五大连池 → 黑河，三段三种深浅。
              The top-right corner stays clear for the agent's note. */}
          <Leg d="M330 355 C 350 320, 395 300, 430 265" color={PLAN_A.day1} delay={200} />
          <Leg d="M430 265 C 425 230, 380 215, 345 195" color={PLAN_A.day2} delay={500} />
          <Leg d="M345 195 C 320 165, 320 135, 290 105" color={PLAN_A.day3} delay={800} />
          {/* 大兴安岭线：加格达奇 → 根河 → 漠河 */}
          <Leg d="M215 290 C 195 262, 160 250, 130 215" color={PLAN_B.day1} delay={400} />
          <Leg d="M130 215 C 110 175, 125 135, 150 100" color={PLAN_B.day2} delay={700} />
          {[[240, 150], [470, 180], [505, 290], [185, 345], [400, 120]].map(([x, y], i) => <Spot key={i} x={x} y={y} color={SPOTS} delay={1200 + i * 80} />)}
          <Pin x={330} y={355} color={PLAN_A.day1} label="1" name="哈尔滨" delay={300} />
          <Pin x={430} y={265} color={PLAN_A.day2} label="2" name="伊春" delay={600} />
          <Pin x={345} y={195} color={PLAN_A.day3} label="4" name="五大连池" nameSide="left" delay={900} />
          <Pin x={290} y={105} color={PLAN_A.day3} label="5" name="黑河" delay={1100} />
          <Pin x={215} y={290} color={PLAN_B.day1} label="1" name="加格达奇" delay={500} />
          <Pin x={130} y={215} color={PLAN_B.day2} label="3" name="根河" nameSide="left" delay={800} />
          <Pin x={150} y={100} color={PLAN_B.day2} label="6" name="漠河" delay={1000} />
        </svg>
        <div className="lp-float lp-float-tr lp-agent-note">
          <span className="lp-agent-note-head"><Sparkles size={12} />Agent · v3</span>
          <span>第 2 天宿五大连池，温泉休整；第 4 天再北上黑河。</span>
        </div>
        <div className="lp-float lp-float-bl lp-metrics"><strong>1,180 km</strong><i /><strong>9 天</strong><i /><span>2 条路线对比</span></div>
        <div className="lp-float lp-float-br lp-handoff-chip"><Send size={12} />交给 Agent · 2 条</div>
      </div>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Demo 1 · layers                                                     */
/* ------------------------------------------------------------------ */

const LAYER_STEPS = [300, 1200, 2200, 4200] as const;

const DEMO_LAYERS = [
  { id: 'a', name: '方案 A · 自驾', by: 'Agent A', meta: '路线 · 3 站 · 2 天', color: PLAN_A.base },
  { id: 'b', name: '方案 B · 经安纳西', by: 'Agent B', meta: '路线 · 3 站 · 2 天', color: PLAN_B.base },
  { id: 's', name: '候选住宿 · 餐厅', by: '你', meta: '地点集 · 4 个', color: SPOTS },
] as const;

export function LayersDemo({ active }: { active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const step = useSteps(LAYER_STEPS, active && !reduced);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setHidden(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const shown = (id: string, since: number) => step >= since && !hidden.has(id);
  const fade = (on: boolean): CSSProperties => ({ opacity: on ? 1 : 0, transition: 'opacity 0.35s ease' });
  return <div className={`lp-stage${reduced ? ' lp-still' : ''}`}>
    <svg viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <Basemap w={640} h={400} />
      {/* Plan B is drawn first so that, at the two stops the plans share, plan A's
          pin sits on top; hide A and B's own pins are there underneath. */}
      {step >= 2 && <g style={fade(shown('b', 2))}>
        <Leg d="M540 300 C 500 240, 400 150, 300 120" color={PLAN_B.day1} />
        <Leg d="M300 120 C 250 118, 200 160, 170 215" color={PLAN_B.day2} delay={250} />
        <Pin x={540} y={300} color={PLAN_B.day1} label="1" delay={100} />
        <Pin x={300} y={120} color={PLAN_B.day2} label="2" name="安纳西 · 住宿" delay={300} />
        <Pin x={170} y={215} color={PLAN_B.day2} label="2" delay={500} />
      </g>}
      {step >= 1 && <g style={fade(shown('a', 1))}>
        <Leg d="M540 300 C 500 290, 430 292, 380 262" color={PLAN_A.day1} />
        <Leg d="M380 262 C 330 235, 250 225, 170 215" color={PLAN_A.day2} delay={250} />
        <Pin x={540} y={300} color={PLAN_A.day1} label="1" name="米兰" delay={100} />
        <Pin x={380} y={262} color={PLAN_A.day2} label="2" name="都灵 · 住宿" nameSide="top" delay={300} />
        <Pin x={170} y={215} color={PLAN_A.day2} label="2" name="里昂" nameSide="left" delay={500} />
      </g>}
      {step >= 3 && <g style={fade(shown('s', 3))}>
        {[[330, 190], [235, 140], [470, 225], [255, 300]].map(([x, y], i) => <Spot key={i} x={x} y={y} color={SPOTS} delay={i * 90} />)}
      </g>}
    </svg>
    <div className="lp-float lp-float-tl lp-panel">
      <div className="lp-panel-head">图层<span className="lp-count">{Math.min(step, 3)}</span></div>
      {DEMO_LAYERS.map((layer, index) => {
        const arrived = step >= index + 1;
        const on = !hidden.has(layer.id);
        return <button key={layer.id} type="button" className={`lp-layer-row lp-layer-row-btn${arrived ? '' : ' lp-layer-row-pending'}`}
          aria-pressed={on} aria-label={`${on ? '隐藏' : '显示'}${layer.name}`} disabled={!arrived} onClick={() => toggle(layer.id)}>
          <span className="lp-swatch" style={{ background: layer.color }} />
          <span className="lp-layer-text"><strong>{layer.name}</strong><small>{layer.by} · {layer.meta}</small></span>
          {on ? <Eye size={14} className="lp-layer-eye" /> : <EyeOff size={14} className="lp-layer-eye lp-layer-eye-off" />}
        </button>;
      })}
      <div className="lp-panel-foot">点眼睛可切换显示</div>
    </div>
    <div className={`lp-float lp-float-tr lp-toast${step >= 2 && step < 4 ? ' lp-toast-in' : ''}`} aria-hidden={step < 2 || step >= 4}>
      <span className="lp-toast-dot" style={{ background: PLAN_B.base }} />
      <span><strong>Agent B</strong> 新增图层 <code>layer.add</code> · v3</span>
    </div>
    <div className="lp-float lp-float-br lp-metrics lp-metrics-sm"><strong>2 条方案</strong><i /><span>baseVersion 3</span></div>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Demo 2 · editing a path                                             */
/* ------------------------------------------------------------------ */

const EDIT_STEPS = [900, 1700, 2900, 3900, 4900, 6500] as const;
const EDIT_LOOP = 9200;
const TURIN = { x: 340, y: 255 };
const ANNECY = { x: 290, y: 110 };

export function EditDemo({ active }: { active: boolean }) {
  const reduced = usePrefersReducedMotion();
  const step = useSteps(EDIT_STEPS, active && !reduced, reduced ? undefined : EDIT_LOOP);
  const moved = step >= 2;
  const solved = step >= 4;
  const shift = moved ? { dx: ANNECY.x - TURIN.x, dy: ANNECY.y - TURIN.y, lifted: step >= 1 && step < 4 } : { dx: 0, dy: 0, lifted: step >= 1 };
  const cursor: CSSProperties = {
    transform: `translate(${(moved ? ANNECY.x : TURIN.x) + 6}px, ${(moved ? ANNECY.y : TURIN.y) + 6}px)`,
    transition: 'transform 0.9s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease',
    opacity: step >= 1 && step < 4 ? 1 : 0,
  };
  return <div className={`lp-stage${reduced ? ' lp-still' : ''}`}>
    <svg viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <Basemap w={640} h={400} />
      {/* 原路线：拖动后退成灰色虚线，直到新道路解算出来 */}
      <g style={{ opacity: solved ? 0 : 1, transition: 'opacity 0.4s ease' }}>
        <Leg d="M500 250 C 460 250, 390 272, 340 255" color={moved ? '#b8bcc4' : PLAN_A.day1} draw={false} dim={moved} />
        <Leg d="M340 255 C 290 236, 220 216, 150 200" color={moved ? '#b8bcc4' : PLAN_A.day2} draw={false} dim={moved} />
      </g>
      {solved && <g>
        <Leg d="M500 250 C 450 200, 360 130, 290 110" color={PLAN_A.day1} />
        <Leg d="M290 110 C 240 110, 190 155, 150 200" color={PLAN_A.day2} delay={300} />
      </g>}
      <Pin x={500} y={250} color={PLAN_A.day1} label="1" name="米兰" />
      <Pin x={150} y={200} color={PLAN_A.day2} label="2" name="里昂" nameSide="left" />
      <Pin x={TURIN.x} y={TURIN.y} color={PLAN_A.day2} label="2" name={solved ? '安纳西 · 住宿' : '都灵 · 住宿'} nameSide="top" shift={shift} />
      <g style={cursor}>
        <path d="M0 0 L0 15 L4.2 11.2 L7 17.2 L9.4 16.1 L6.7 10.2 L12 10.2 Z" fill="#1f2329" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </g>
    </svg>
    <div className={`lp-float lp-float-tc lp-chip${step >= 3 ? ' lp-chip-in' : ''}${solved ? ' lp-chip-ok' : ''}`} aria-live="polite">
      {solved ? <Check size={13} /> : <LoaderCircle size={13} className="lp-spin" />}
      {solved ? '已按道路重新解算 · OSRM' : '道路重新解算中…'}
    </div>
    <div className="lp-float lp-float-bl lp-metrics"><strong>驾车 · 2 天</strong><i /><strong>{solved ? '512 km' : '456 km'}</strong><i /><span>{solved ? '5 小时 40 分' : '4 小时 58 分'}</span></div>
    <div className={`lp-float lp-float-br lp-card lp-handoff${step >= 5 ? ' lp-card-in' : ''}`} aria-hidden={step < 5}>
      <div className="lp-card-head">本轮修改<span className="lp-count">1</span></div>
      <div className="lp-handoff-item"><span className="lp-swatch" style={{ background: PLAN_A.day2 }} />移动「都灵 · 住宿」→ 安纳西 · 第 2 天</div>
      <div className={`lp-handoff-btn${step >= 6 ? ' lp-handoff-sent' : ''}`}>
        {step >= 6 ? <><Check size={13} />已发送 · Agent 读取 v4</> : <><Send size={13} />交给 Agent · 1 条</>}
      </div>
    </div>
    <div className={`lp-float lp-float-tr lp-bubble${step >= 6 ? ' lp-bubble-in' : ''}`} aria-hidden={step < 6}>
      <span className="lp-avatar"><Bot size={13} /></span>
      <span>收到。第 2 天改经安纳西，住宿换到湖边，已更新到 v5。</span>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ */
/* Demo 3 · sharing                                                    */
/* ------------------------------------------------------------------ */

const SHARE_STEPS = [3000, 6200] as const;
const SHARE_LOOP = 9400;
const DEMO_MAP_ID = 'milan-lyon';
const DEMO_TOKEN = 'pv_demo_7hq2c9xk';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(value) === 'unavailable') return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  };
  return <button type="button" className="lp-copy-btn" aria-label={copied ? '已复制' : `复制${label}`} title={copied ? '已复制' : '复制'} onClick={copy}>
    {copied ? <Check size={14} /> : <Copy size={14} />}
  </button>;
}

export function ShareDemo({ active, origin }: { active: boolean; origin: string }) {
  const reduced = usePrefersReducedMotion();
  const [touched, setTouched] = useState(false);
  const [manual, setManual] = useState(false);
  const step = useSteps(SHARE_STEPS, active && !reduced && !touched, reduced || touched ? undefined : SHARE_LOOP);
  const canWrite = touched ? manual : step === 1;
  const choose = (value: boolean) => { setTouched(true); setManual(value); };
  const link = `${origin}/map/${DEMO_MAP_ID}#preview=${DEMO_TOKEN}`;
  const call = `id="${DEMO_MAP_ID}", previewToken="${DEMO_TOKEN}"`;
  const handoff = `Cartula 地图分享\n地图 id：${DEMO_MAP_ID}\n分享凭据 previewToken：${DEMO_TOKEN}\n分享地址：${link}\n请调用 get_map(${call}) 读取这张地图${canWrite ? `，也可以调用 patch_map(${call}, …) 修改它` : '；这个链接只读，不能修改这张地图'}。`;
  const perms: Array<[string, boolean]> = [['get_map', true], ['copy_map', true], ['patch_map', canWrite], ['delete_map', false], ['share_map', false]];
  return <div className={`lp-stage lp-stage-share${reduced ? ' lp-still' : ''}`}>
    <div className="lp-dialog" role="group" aria-label="分享地图示意">
      <div className="lp-dialog-head"><strong>分享地图</strong><span>米兰—里昂两日自驾</span></div>
      <div className="lp-seg" role="group" aria-label="对方的权限">
        <button type="button" className={canWrite ? '' : 'lp-seg-on'} aria-pressed={!canWrite} onClick={() => choose(false)}>只读</button>
        <button type="button" className={canWrite ? 'lp-seg-on' : ''} aria-pressed={canWrite} onClick={() => choose(true)}>可编辑</button>
      </div>
      <p className="lp-dialog-hint">{canWrite ? '对方可以改这张地图，不能删除或再分享。' : '对方只能查看、导出和复制。'}</p>
      <label className="lp-field-label">分享链接</label>
      <div className="lp-copy-field"><input readOnly value={link} aria-label="分享链接" onFocus={e => e.currentTarget.select()} /><CopyButton value={link} label="分享链接" /></div>
      <label className="lp-field-label">分享给 Agent</label>
      <div className="lp-copy-field lp-copy-multi"><textarea readOnly rows={5} value={handoff} aria-label="分享给 Agent 的文字" onFocus={e => e.currentTarget.select()} /><CopyButton value={handoff} label="分享给 Agent 的文字" /></div>
      <div className="lp-share-list">
        <div className="lp-share-list-head">这张图现有的分享 · 2</div>
        <div className="lp-share-row"><span>刚刚<small>{canWrite ? '可编辑' : '只读'}</small></span><span className="lp-share-off">停用</span></div>
        <div className="lp-share-row"><span>9 月 18 日<small>只读</small></span><span className="lp-share-off">停用</span></div>
      </div>
    </div>
    <div className="lp-chat" aria-label="对方的对话示意">
      <div className="lp-chat-head">对方的对话</div>
      <div className="lp-msg lp-msg-user">（粘贴）Cartula 地图分享 · 地图 id：{DEMO_MAP_ID} · previewToken：{DEMO_TOKEN.slice(0, 10)}…</div>
      <div className="lp-msg lp-msg-agent">
        <span className="lp-avatar"><Bot size={13} /></span>
        <span key={String(canWrite)} className="lp-msg-text">
          {canWrite
            ? <>已读取《米兰—里昂两日自驾》：2 天 3 站。这条分享允许编辑，我直接在方案上把第 2 天改经安纳西（<code>patch_map</code>）。</>
            : <>已读取《米兰—里昂两日自驾》：2 天 3 站。这条分享只读；要改的话我先复制一份到你的空间（<code>copy_map</code>）再规划。</>}
        </span>
      </div>
      <div className="lp-toolcall" key={`call-${canWrite}`}>
        <Check size={12} />
        <code>{canWrite ? `patch_map(${call}, baseVersion=4, operations=[…])` : `get_map(${call})`}</code>
      </div>
      <ul className="lp-perms" aria-label="对方的 Agent 可以调用">
        {perms.map(([tool, ok]) => <li key={tool} className={ok ? 'lp-perm-ok' : 'lp-perm-no'}>{ok ? <Check size={12} /> : <span className="lp-perm-x">×</span>}<code>{tool}</code></li>)}
      </ul>
    </div>
  </div>;
}

/* ------------------------------------------------------------------ */

export function DemoCaption({ children }: { children: ReactNode }) {
  return <p className="lp-demo-caption">{children}</p>;
}
