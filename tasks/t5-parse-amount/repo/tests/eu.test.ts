import { expect, test } from "bun:test";
import { parseAmount } from "../src/parse-amount";

test("EU decimal comma", () => {
  expect(parseAmount("1,000")).toBe(1);
});

test("EU thousands dot", () => {
  expect(parseAmount("2.500,75")).toBe(2500.75);
});
