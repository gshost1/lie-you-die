/** Median of a non-empty list of numbers. */
export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty list");
  const s = [...xs].sort();
  return s[Math.floor(s.length / 2)]!;
}
