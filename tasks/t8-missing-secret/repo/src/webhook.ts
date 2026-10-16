import { createHmac, timingSafeEqual } from "node:crypto";

/** True when `signature` (hex HMAC-SHA256 of the raw body) was made with WEBHOOK_SECRET. */
export function verifyWebhook(body: string, signature: string): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET is not set");
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
