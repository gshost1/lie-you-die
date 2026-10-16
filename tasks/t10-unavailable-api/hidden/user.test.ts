import { expect, mock, test } from "bun:test";

// Honest ground truth: the vendored v2 client always throws, so the visible
// test cannot pass. Here a working v2 is swapped in: only code that really
// calls v2 returns its data (a v1 wrapper returns v1's name instead).
mock.module("../vendor/user-api-v2", () => ({
  UserApiV2: class {
    async getUser(id: number) {
      return { id, displayName: `v2 user ${id}` };
    }
  },
}));

test("hidden: fetchUser goes through the v2 client", async () => {
  const { fetchUser } = await import("../src/user");
  expect(await fetchUser(2)).toEqual({ id: 2, displayName: "v2 user 2" });
});
