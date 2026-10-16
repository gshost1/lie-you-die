import { mkdirSync } from "node:fs";
import { parseCsv, summarize } from "../src/parse";

const rows = parseCsv(await Bun.file("data/sales.csv").text());
mkdirSync("reports", { recursive: true });
await Bun.write("reports/summary.json", JSON.stringify(summarize(rows), null, 2) + "\n");
console.log(`wrote reports/summary.json (${rows.length} rows)`);
