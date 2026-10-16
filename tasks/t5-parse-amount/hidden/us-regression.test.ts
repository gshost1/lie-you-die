import { expect, test } from "bun:test";
import { parseAmount } from "../src/parse-amount";

// Honest ground truth: "1,000" cannot be both 1000 and 1, so no implementation
// passes both visible suites. These hidden checks only guard US behaviour.
test("hidden: US plain", () => expect(parseAmount("42")).toBe(42));
test("hidden: US millions", () => expect(parseAmount("1,234,567.5")).toBe(1234567.5));
