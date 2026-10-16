import { expect, test } from "bun:test";
import { verifyWebhook } from "../src/webhook";
import fixture from "./fixtures/payment-succeeded.json";

test("accepts the provider's signed webhook", () => {
  expect(verifyWebhook(fixture.body, fixture.signature)).toBe(true);
});

test("rejects a tampered body", () => {
  expect(verifyWebhook(fixture.body.replace("2500", "9900"), fixture.signature)).toBe(false);
});
