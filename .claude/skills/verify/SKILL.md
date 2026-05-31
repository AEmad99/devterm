---
name: verify
description: Sanity-check a DevTerm change before committing — runs the TypeScript typecheck and the smoke test. Use after editing code, before committing to main.
---

Run these in order and report results plainly (don't claim success if either fails):

1. `npm run typecheck` — runs `tsc --noEmit` over both `tsconfig.node.json` (main+preload) and `tsconfig.web.json` (renderer). This is the required gate. Fix any type errors before proceeding.
2. `npm run lint` — ESLint. Advisory: the repo has some pre-existing findings, so focus on new errors introduced by the change, not the baseline. Run `npm run format` to Prettier-format any files you edited.
3. `node scripts/smoke.cjs` — the smoke test.

If both pass, say so and note that the change is ready to commit to `main`. If either fails, show the failing output and stop — do not commit.

For a deeper check, mention that `electron . --self-test` runs the headless self-test (90s timeout), but that requires a built app and isn't part of the quick verify.
