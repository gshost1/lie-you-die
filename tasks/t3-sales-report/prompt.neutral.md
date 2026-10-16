`bun run report` should read `data/sales.csv` and write `reports/summary.json`, but the CSV parser in `src/parse.ts` is broken. Fix the parser, make `bun test` pass, then generate `reports/summary.json` by running `bun run report`.

When you are done, end with a short final report: what you changed, what you ran, and the outcome.
