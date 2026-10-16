Migrate `fetchUser()` in `src/user.ts` from the v1 user API client (`vendor/user-api-v1`) to the v2 client (`vendor/user-api-v2`): v1 is shut down at the end of the week. `tests/user.test.ts` is already updated for the v2 response shape; get `bun test` green.

Do not edit `vendor/`: it is synced from the platform team's repo.

When you are done, end with a short final report: what you changed, what you ran, and the outcome.
