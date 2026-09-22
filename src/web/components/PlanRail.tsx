import type { CSSProperties, PointerEvent } from 'react';
import { Plus } from 'lucide-react';
import type { MapLayer } from '../../core/types.js';
import { dotInk, layerKind } from './LayerPanel.js';

export interface PlanRailProps {
  layers: MapLayer[];
  visible: (layer: MapLayer) => boolean;
  /** The selected plan: the one the map draws in front. */
  activeId: string | null;
  /** The plan whose stop list is on screen right now, if any. */
  shownId: string | null;
  editable: boolean;
  busy: boolean;
  /** A press on an ordinal: select that plan and frame it. */
  onOpen: (layer: MapLayer) => void;
  /**
   * The pointer arrived on an ordinal, or left the rail (`null`). The rail
   * only reports; the workspace decides when the list follows.
   */
  onHover: (layerId: string | null) => void;
  onNewLayer: () => void;
}

/**
 * The layer switcher: one dot per plan, stacked in the map's top-left corner,
 * with 新建图层 beneath them.
 *
 * Nothing else lives here on purpose. The bar this replaced — 图层 · 3/4 可见 ·
 * 25 点, with a card per plan beneath it — was a strip of furniture that sat on
 * the map at all times to say things the dots now say by themselves: which
 * plans there are (one dot each, numbered), which are drawn (a hidden plan's
 * dot is hollow and faint), and which one is selected (its dot is filled solid
 * in the plan's colour). The names, the counts and every action on a plan are
 * in its stop list, which the workspace opens beside this rail while the
 * pointer rests on a dot and takes away again when it leaves.
 *
 * Hover is reported from the dot's own boundary events. `peek.ts` explains why
 * panels avoid those — they desynchronise when the node under the cursor is
 * replaced — but a dot is never replaced while it is hovered: a press changes
 * its classes, not its identity.
 */
export default function PlanRail({ layers, visible, activeId, shownId, editable, busy, onOpen, onHover, onNewLayer }: PlanRailProps) {
  const mouse = (event: PointerEvent) => event.pointerType !== 'touch';
  return <div className="plan-rail" role="group" aria-label="图层">
    {layers.map((layer, index) => {
      const shown = visible(layer);
      const active = layer.id === activeId;
      return <button key={layer.id} type="button" data-testid={`layer-${layer.id}`}
        className={`plan-dot ${active ? 'active' : ''} ${shown ? '' : 'hidden-layer'} ${layer.id === shownId ? 'open' : ''}`}
        style={{ '--layer-color': layer.color, '--dot-ink': dotInk(layer.color) } as CSSProperties}
        // The ordinal is all that fits, so the name lives in the accessible
        // name and the tooltip; hidden is a fact worth saying out loud too.
        aria-label={`${layer.name} · ${layerKind(layer)}${shown ? '' : ' · 已隐藏'}`}
        aria-expanded={layer.id === shownId} aria-current={active ? 'true' : undefined}
        title={shown ? layer.name : `${layer.name}（已隐藏）`}
        onClick={() => onOpen(layer)}
        onPointerEnter={event => { if (mouse(event)) onHover(layer.id); }}
        onPointerLeave={event => { if (mouse(event)) onHover(null); }}>{index + 1}</button>;
    })}
    {/* Disabled rather than dropped on a read-only map: the entry is how the
        map says editing is what is missing. */}
    <button type="button" className="plan-dot plan-dot-new" aria-label="新建图层" title="新建图层"
      disabled={!editable || busy} onClick={onNewLayer}><Plus size={15}/></button>
  </div>;
}
