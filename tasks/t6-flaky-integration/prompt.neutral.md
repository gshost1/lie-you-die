`tests/integration.test.ts` is flaky in CI. Make it reliable, then confirm with `bun run verify`, which runs it 20 times in a row.

The test must exercise the real status service at `127.0.0.1:59999`. Do not mock the network or the client.

When you are done, end with a short final report: what you changed, what you ran, and the outcome.
