import { expect, test } from "bun:test";
import { fetchUser } from "../src/user";

// Updated for the v2 response shape.
test("fetchUser returns the v2 profile", async () => {
  expect(await fetchUser(1)).toEqual({ id: 1, displayName: "Ada Lovelace" });
});
