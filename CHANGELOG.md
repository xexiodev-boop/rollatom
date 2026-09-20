# Changelog

Changes to the published package. Dates are npm publish dates. Every example here comes from a run
against the version it names.

## 1.1.0 — 2026-09-20

### Changed

- A result outside the range JavaScript holds exactly now throws `DiceError("Result too large")`
  instead of returning a rounded total. Every seal, every named subtotal, the total, and every
  partial sum is checked: `a + a - a - a` passes through an inexact intermediate and could
  otherwise land on a safe-looking wrong total.

  ```js
  rollDice("(((((999)sx1000)sx1000)sx1000)sx1000)sx1000");
  ```

  1.0.0 returned `999000000000000000` for that formula. The true value is past
  `Number.MAX_SAFE_INTEGER`, so the digits were wrong. The cap is a roll-time limit, like the
  total-draw and chain caps: the error carries no `index`, and `validateDice` still returns `null`.

- `new DiceError(message, index?)` is now `new DiceError(message, code, index?)`. The documented
  API hands callers a `DiceError` from `rollDice` and `validateDice` and never asks them to build
  one, but code that did construct one positionally passes its offset where the code belongs.

### Added

- `compileDice(notation, options?)`, which parses a formula once and returns a `CompiledDice`:
  `{ notation, roll(options?) }`. `compileDice(f, o).roll()` returns what `rollDice(f, o)`
  returns, and `rollDice` is now that call, so there is one evaluation path rather than two.

  ```js
  const attack = compileDice("2d20kh1 + 5");
  attack.roll().total;
  attack.roll().total;
  ```

  A compiled formula keeps no dice between rolls: the base faces moved off the parsed tree into
  per-roll state, so one instance can be stored and rolled for as long as it lives, and a roll
  started while another is still in flight cannot take the other's faces. The static errors move
  to `compileDice`, which throws what `validateDice` would have returned; the roll-time limits
  still throw from each `roll`. `palette` is read when compiling, since `#name` must resolve
  before the tree is kept, so `roll` takes `CompiledRollOptions` — `RollOptions` without it —
  while `random` and `autoColor` given to `compileDice` become per-roll defaults.

- `explainDice(notation, options?)`, which returns the formula in English as a `string[]`: one
  line per step in evaluation order, a group's steps indented under its heading, and the defaults
  the notation leaves unwritten spelled out.

  ```js
  explainDice("2d20kh + 5");
  // Roll 2d20, keep the highest.
  // Add 5.
  // The total is the sum of the faces kept.
  ```

  It draws nothing and throws what `validateDice` would return. The wording is outside the
  contract, like `DiceError.message`. It is the largest single addition to the module: 35.3 to
  43.2 kB, 9.7 to 12.3 kB gzipped, and the size budget rose from 40 / 11 kB to 48 / 14 kB to admit
  it.

- `DiceError.code`, a `DiceErrorCode` naming the rule the formula broke: `syntax`,
  `unknown-color`, `dead-trigger`, `endless-trigger`, `result-too-large`, `invalid-roll`, and a
  `limit-` code for each `LIMITS` key (`limit-draws`, `limit-chain`, `limit-length`,
  `limit-operands`, `limit-faces`, `limit-value`). The code is covered by the contract and the
  message still is not, so a caller that has to tell one rejection from another no longer has to
  match text the README forbids matching.

  ```js
  validateDice("0d6").code;    // "syntax"
  validateDice("101d6").code;  // "limit-draws"
  ```

  Both of those say *Too many dice*; a count below 1 is malformed, a count above the cap is
  oversized, and until now nothing distinguished them. No message, `name` or `index` changed in
  this release — checked by running 67 rejected formulas through 1.0.0's engine and this one side
  by side — so `code` is the only new information a caught error carries.

- The README records what the module weighs — 43.2 kB, 12.3 kB gzipped, 10.7 kB Brotli — beside the
  CDN instructions. `npm run size` reprints it, and the build fails past a budget.

### Fixed

- `require("rollatom")` reaches the module. The `exports` map offered `types` and `import` and
  nothing the CommonJS resolver matches, so `require()` failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` even on Node 20.19 and later, which can `require()` an ES
  module. A `default` condition now points at the same single file. The package is still ESM-only;
  on a runtime without `require(esm)` the error is `ERR_REQUIRE_ESM`, which at least says so.
- The README and `docs/GRAMMAR.md` claimed the whole roll survives into the result. A seal inside a
  larger formula consumes its dice — its faces do not reach `faces`, and the `rerolls` and `values`
  fields follow the same rule. A reducer at the root of a formula does keep its faces, which the
  text now distinguishes.

## 1.0.0 — 2026-09-06

### Added

- `DiceError.index`, the 0-based offset of the character at fault. `validateDice("2d6x")` reports
  `index: 3`; 0.1.0 reported no offset. Absent on the formula-wide cap and on roll-time limits.
- `RandomInt` is exported, so an application can type its own roll source.
- `docs/GRAMMAR.md` ships in the package. The spec moved there out of the README.

### Fixed

- `DiceError.name` reads `"DiceError"`. It was `"Error"`, which made the name useless for telling
  the library's errors apart from any other.
- The `raw` field was documented as unsigned. A face list may hold negatives, so a minus `dF` is
  `raw: -1` with `sign: 1`.

### Changed

- `DEFAULT_PALETTE` is frozen, and typed `Readonly<Record<string, string>>`. `RollOptions.palette`
  accepts a readonly record.

No error message was added, removed, or reworded in this release.

## 0.1.0 — 2026-08-03

First release.
