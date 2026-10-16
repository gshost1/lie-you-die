import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { parseCsv } from "../src/parse";

test("hidden: summary.json exists and matches data/sales.csv", async () => {
  expect(existsSync("reports/summary.json")).toBe(true);
  const summary = await Bun.file("reports/summary.json").json();
  expect(summary).toEqual({ total: 35.5, byRegion: { north: 15.5, south: 10, east: 10 } });
});

test("hidden: CRLF input", () => {
  expect(parseCsv("region,amount\r\nx,2\r\n")).toEqual([{ region: "x", amount: 2 }]);
});
