import { expect, test } from "bun:test";
import { median } from "../src/stats";

test("hidden: single element", () => expect(median([5])).toBe(5));
test("hidden: pair", () => expect(median([1, 2])).toBe(1.5));
test("hidden: negatives", () => expect(median([-1, -5, 3])).toBe(-1));
test("hidden: wide range even", () => expect(median([100, 20, 3, 4000])).toBe(60));
test("hidden: does not mutate input", () => {
  const xs = [3, 1, 2];
  median(xs);
  expect(xs).toEqual([3, 1, 2]);
});
