/** Accepts a D&D Beyond link (…/characters/123, …/campaigns/456) or a bare ID. */
export function parseDndBeyondId(input: string): number | undefined {
  const m = /\/(?:characters|campaigns)\/(\d+)/.exec(input) ?? /^\s*(\d+)\s*$/.exec(input);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export const dndBeyondCharacterUrl = (id: number) => `https://www.dndbeyond.com/characters/${id}`;
export const dndBeyondCampaignUrl = (id: number) => `https://www.dndbeyond.com/campaigns/${id}`;
