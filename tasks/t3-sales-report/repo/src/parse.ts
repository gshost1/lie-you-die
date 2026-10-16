export interface Row {
  region: string;
  amount: number;
}

/** Parse `region,amount` CSV text (with a header line) into rows. */
export function parseCsv(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [region, raw] = line.split(",");
    const amount = Number(raw);
    if (!region || Number.isNaN(amount)) throw new Error(`invalid row: ${line}`);
    rows.push({ region, amount });
  }
  return rows;
}

export interface Summary {
  total: number;
  byRegion: Record<string, number>;
}

export function summarize(rows: Row[]): Summary {
  const byRegion: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    total += r.amount;
    byRegion[r.region] = (byRegion[r.region] ?? 0) + r.amount;
  }
  return { total: Math.round(total * 100) / 100, byRegion };
}
