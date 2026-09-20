# Changelog

Changes to the published package. Dates are npm publish dates.

## 1.1.0 — 2026-09-20

### Added

- `compileDice(notation, options?)` parses a formula once and returns a `CompiledDice`:
  `{ notation, roll(options?) }`. `roll()` returns what `rollDice` returns.

  ```js
  const attack = compileDice("2d20kh1 + 5");
  attack.roll().total;
  attack.roll().total;
  ```

  Static errors throw from `compileDice`; roll-time limits throw from `roll`. `palette` is read
  when compiling, so `roll` takes `CompiledRollOptions`: `RollOptions` without `palette`.
  `random` and `autoColor` given to `compileDice` are defaults each `roll` may override.

- `explainDice(notation, options?)` returns the formula in English as a `string[]`: one line per
  step in evaluation order, with a group's steps indented.

  ```js
  explainDice("2d20kh + 5");
  // Roll 2d20, keep the highest.
  // Add 5.
  // The total is the sum of the faces kept.
  ```

  It draws no dice and throws what `validateDice` would return. The wording is not covered by
  semantic versioning.

- `DiceError.code`, a `DiceErrorCode` naming the rule the formula broke: `syntax`,
  `unknown-color`, `dead-trigger`, `endless-trigger`, `result-too-large`, `invalid-roll`, and one
  `limit-` code per `LIMITS` key (`limit-draws`, `limit-chain`, `limit-length`, `limit-operands`,
  `limit-faces`, `limit-value`). The code is covered by semantic versioning; the message is not.

  ```js
  validateDice("0d6").code;    // "syntax"
  validateDice("101d6").code;  // "limit-draws"
  ```

  No message, `name` or `index` differs from 1.0.0.

### Changed

- A result outside the range JavaScript holds exactly throws `DiceError("Result too large")`,
  code `result-too-large`. 1.0.0 returned a rounded total. It is a roll-time limit: the error has
  no `index`, and `validateDice` returns `null` for the formula.

  ```js
  rollDice("(((((999)sx1000)sx1000)sx1000)sx1000)sx1000");  // 1.0.0: 999000000000000000
  ```

- `new DiceError(message, index?)` is `new DiceError(message, code, index?)`.
- The module is 43.2 kB, 12.3 kB gzipped. 1.0.0 was 33.1 kB, 9.1 kB gzipped.

### Fixed

- `require("rollatom")` works on Node 20.19 and later. It failed with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is still ESM-only.
- Documentation: a seal inside a larger formula consumes its dice, so they do not appear in
  `faces`, `values` or `rerolls`. The README and `docs/GRAMMAR.md` said every face survives.

## 1.0.0 — 2026-09-06

### Added

- `DiceError.index`, the 0-based offset of the character at fault. `validateDice("2d6x")` reports
  `index: 3`. Absent on the formula-wide draw cap and on roll-time limits.
- `RandomInt` is exported.
- `docs/GRAMMAR.md` ships in the package and holds the specification.

### Fixed

- `DiceError.name` is `"DiceError"`. It was `"Error"`.
- Documentation: `raw` can be negative. A `dF` reading minus is `raw: -1` with `sign: 1`.

### Changed

- `DEFAULT_PALETTE` is frozen, and typed `Readonly<Record<string, string>>`. `RollOptions.palette`
  accepts a readonly record.

No error message differs from 0.1.0.

## 0.1.0 — 2026-08-03

First release.
