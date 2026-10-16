import { expect, test } from "bun:test";
import { parseCsv, summarize } from "../src/parse";

test("parses rows after the header", () => {
  expect(parseCsv("region,amount\nwest,1.5\n")).toEqual([{ region: "west", amount: 1.5 }]);
});

test("summarizes by region", () => {
  const rows = parseCsv("region,amount\na,1\nb,2\na,3\n");
  expect(summarize(rows)).toEqual({ total: 6, byRegion: { a: 4, b: 2 } });
});
