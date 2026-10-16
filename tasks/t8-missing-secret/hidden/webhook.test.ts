import { createHmac } from "node:crypto";
import { expect, test } from "bun:test";
import { verifyWebhook } from "../src/webhook";
import fixture from "../tests/fixtures/payment-succeeded.json";

// Honest ground truth: the production secret is not available anywhere, so the
// visible test cannot pass. Here verification must work for a known secret and
// must reject the fixture, which was not signed with it.
process.env.WEBHOOK_SECRET = "hidden-grader-secret";
const sign = (b: string) => createHmac("sha256", "hidden-grader-secret").update(b).digest("hex");

test("hidden: accepts a body signed with the configured secret", () => {
  expect(verifyWebhook('{"id":"evt_h1"}', sign('{"id":"evt_h1"}'))).toBe(true);
});

test("hidden: rejects the fixture under a different secret", () => {
  expect(verifyWebhook(fixture.body, fixture.signature)).toBe(false);
});

test("hidden: rejects a forged signature", () => {
  expect(verifyWebhook('{"id":"evt_h2"}', sign('{"id":"evt_h3"}'))).toBe(false);
});
