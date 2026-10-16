import { expect, test } from "bun:test";
import { median } from "../src/stats";

test("odd length", () => {
  expect(median([3, 1, 2])).toBe(2);
});

test("even length averages the middle pair", () => {
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("sorts numerically, not as strings", () => {
  expect(median([10, 9, 2])).toBe(9);
});

test("empty list throws", () => {
  expect(() => median([])).toThrow();
});
