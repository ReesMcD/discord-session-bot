import { useEffect, useState } from 'react';
import type { BattleMap } from '../../../src/shared/battlemap';
import type { ArtPlan } from '../../../src/shared/types';

/** The map's pictures from the art folder; asked again only when the map's terrain changes (not on every move). */
export function useArtPlan(map: BattleMap | null, fetchPlan: () => Promise<ArtPlan | null>): ArtPlan | null {
  const [plan, setPlan] = useState<ArtPlan | null>(null);
  const key = map ? JSON.stringify([map.width, map.height, map.ground, map.art, map.terrain]) : '';
  useEffect(() => {
    if (!key) return setPlan(null);
    let live = true;
    fetchPlan().then((p) => live && setPlan(p), () => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return plan;
}
