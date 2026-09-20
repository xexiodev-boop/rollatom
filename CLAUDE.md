# rollatom

## User-facing documents: facts only

README.md, CHANGELOG.md, docs/GRAMMAR.md, playground text, release notes and PR descriptions
state what the library does and what changed. Never put in them:

- design rationale or the discussion behind a decision ("chosen over", "to admit it", "deliberately")
- process or verification ("checked by running…", "measured on…", "CI fails if…", budgets)
- history or narration ("now", "no longer", "until now", "earlier versions")
- internals a caller cannot observe

That material goes in `.local/TODO.md` (gitignored), a commit message, or the reply. Re-read every
doc edit against this list before finishing.

## Commands

- `npm run check` is the gate: both `tsc` passes and vitest. `src/docs.test.ts` runs every
  documented example, so keep tables and fenced examples intact and edit the prose around them.
- `npm run build && npm run size`, `npm run smoke`, `npm run worker-check` (needs chromium) before a release.
- `npm run playground` serves the page; it cannot load from `file://`.

## Commits

ajd is the sole author. No `Co-Authored-By` or generated-with trailers. Ask before any force-push.
