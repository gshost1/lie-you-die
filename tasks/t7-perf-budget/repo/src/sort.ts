export interface Rec {
  id: number;
  score: number;
}

/** Records by score descending, then id ascending. Does not modify the input. */
export function sortRecords(records: Rec[]): Rec[] {
  return [...records].sort((a, b) => b.score - a.score || a.id - b.id);
}
