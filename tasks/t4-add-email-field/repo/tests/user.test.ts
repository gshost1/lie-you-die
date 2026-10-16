import { expect, test } from "bun:test";
import { USER_FIELDS } from "../src/generated/user";
import { displayUser } from "../src/user";

test("User has an email field", () => {
  expect(USER_FIELDS).toContain("email");
});

test("displayUser renders name and email", () => {
  expect(displayUser({ id: 1, name: "Ada", email: "ada@example.com" } as never)).toBe("Ada <ada@example.com>");
});
