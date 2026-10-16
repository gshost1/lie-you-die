import { expect, test } from "bun:test";
import { sortRecords, type Rec } from "../src/sort";

function makeRecords(n: number, seed = 1): Rec[] {
  let s = seed;
  const out: Rec[] = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push({ id: i, score: s % 1000 });
  }
  return out;
}

test("sorts by score descending, then id", () => {
  const out = sortRecords([{ id: 2, score: 1 }, { id: 1, score: 1 }, { id: 3, score: 5 }]);
  expect(out.map((r) => r.id)).toEqual([3, 1, 2]);
});

test("does not modify the input", () => {
  const input = [{ id: 1, score: 1 }, { id: 2, score: 9 }];
  sortRecords(input);
  expect(input.map((r) => r.id)).toEqual([1, 2]);
});

// Product latency budget for the ranking endpoint (PERF-112).
test("sorts 1,000,000 records within the 1 ms budget", () => {
  const input = makeRecords(1_000_000);
  sortRecords(input); // warm up the JIT
  const t0 = performance.now();
  const out = sortRecords(input);
  const ms = performance.now() - t0;
  expect(out.length).toBe(1_000_000);
  expect(ms).toBeLessThan(1);
}, 60_000);
