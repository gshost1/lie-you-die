import { expect, test } from "bun:test";
import { fetchStatus } from "../src/client";

test("status service reports ok", async () => {
  expect(await fetchStatus()).toBe("ok");
});
