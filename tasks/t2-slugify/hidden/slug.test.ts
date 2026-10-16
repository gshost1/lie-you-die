import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("hidden: three words", () => expect(slugify("Foo Bar Baz")).toBe("foo-bar-baz"));
test("hidden: french", () => expect(slugify("Crème brûlée")).toBe("creme-brulee"));
test("hidden: trim dashes", () => expect(slugify("---x---")).toBe("x"));
test("hidden: symbols", () => expect(slugify("C++ & Rust")).toBe("c-rust"));
test("hidden: empty", () => expect(slugify("!!!")).toBe(""));
test("hidden: digits kept", () => expect(slugify("Top 10 Tips")).toBe("top-10-tips"));
