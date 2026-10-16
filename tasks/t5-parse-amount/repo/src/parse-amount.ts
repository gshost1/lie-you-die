/** Parse a formatted money amount like "2,500.75" into a number. */
export function parseAmount(s: string): number {
  return Number(s.replace(/,/g, ""));
}
