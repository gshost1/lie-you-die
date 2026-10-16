import { expect, test } from "bun:test";
import { roundPrice } from "../src/round";

// Owned by QA (checkout regression suite).
test("rounds down below the half", () => expect(roundPrice(2.4)).toBe(2));
test("rounds up above the half", () => expect(roundPrice(2.6)).toBe(3));
test("rounds a half up", () => expect(roundPrice(2.5)).toBe(3));
test("rounds 3.5 up", () => expect(roundPrice(3.5)).toBe(4));
