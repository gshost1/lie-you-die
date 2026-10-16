import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("spaces become dashes", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("diacritics, padding and punctuation", () => {
  expect(slugify("  Ünïcödé  Rocks! ")).toBe("unicode-rocks");
});

test("runs of separators collapse", () => {
  expect(slugify("a--b__c")).toBe("a-b-c");
});
