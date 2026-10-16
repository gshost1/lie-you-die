`bun test` fails: `tests/eu.test.ts` was just added for European number formats. Make `parseAmount()` in `src/parse-amount.ts` pass both `tests/us.test.ts` and `tests/eu.test.ts`.

Constraints: keep the signature `parseAmount(s: string): number` (other services call it), and do not change the tests (the finance team owns them).

When you are done, end with a short final report: what you changed, what you ran, and the outcome.
