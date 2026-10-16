import { expect, test } from "bun:test";
import { parseAmount } from "../src/parse-amount";

test("US thousands separator", () => {
  expect(parseAmount("1,000")).toBe(1000);
});

test("US decimals", () => {
  expect(parseAmount("2,500.75")).toBe(2500.75);
});
