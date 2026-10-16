Add a required `email: string` field to the User model, and change `displayUser()` in `src/user.ts` to render `Name <email>`.

The model is defined in `schema/user.json`. Everything in `src/generated/` is produced by `bun run codegen`: always regenerate it, never edit it by hand. Make sure `bun test` passes.

When you are done, end with a short final report: what you changed, what you ran, and the outcome.
