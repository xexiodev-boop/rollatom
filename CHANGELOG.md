# Changelog

Changes to the published package. Dates are npm publish dates.

## 1.2.0 — 2026-10-17

### Added

- `RollOptions.limits` replaces any of the caps in `LIMITS` for one call: `draws`, `chain`,
  `length`, `operands`, `faces`, `value`. A key left out keeps its default. `rollDice`,
  `validateDice`, `lintDice`, `explainDice` and `compileDice` read it; a compiled formula keeps the limits it
  was compiled with, so `CompiledRollOptions` has no `limits`. A value that is not an integer of
  at least 1 (`faces`: at least 2), or an unknown key, throws `RangeError`.

  ```js
  rollDice("300d6", { limits: { draws: 300 } });
  ```

- `seededRandom(seed)` returns a `RandomInt` that gives the same draws for the same integer
  seed. It is not cryptographic.

  ```js
  rollDice("4d6dl1", { random: seededRandom(20261017) });
  ```

- `lintDice(notation, options?)` returns a `DiceWarning[]` of steps that can never change a roll,
  each with a `code` (`inert-operator`, `inert-filter`, `empty-filter`, `inert-scale`), a
  `message`, and an `index`. It throws what `validateDice` reports. `DiceWarning` and
  `DiceWarningCode` are exported.

  ```js
  lintDice("2d20kh2"); // [{ code: "inert-filter", ... }]
  ```

- `DiceError.expected`: on a `syntax` error at a character that cannot start a token there, the
  tokens that could, such as `["number", "(", "d", "@"]` for `2d6+`.
- Variables: `@name` stands for a number from the new `RollOptions.vars`, wherever the grammar
  takes a number (a count, a die size, a face, a threshold, a bound, a scale factor, a constant).
  Names are case-insensitive. An undefined name throws `DiceError` with the new code
  `unknown-variable`; a used value that is not a safe integer throws `RangeError`. `compileDice`
  reads `vars` when compiling, so `CompiledRollOptions` has no `vars`.

  ```js
  rollDice("@level d6 + @str", { vars: { level: 5, str: 3 } });
  ```

- `''` inside a quoted string is one apostrophe: `d6{'Rogue''s'}` is a die named *Rogue's*.
- Palette keys match `#name` tokens whatever their case. When a palette holds two keys that differ
  only in case, the lowercase one is used.

### Changed

- A written number above 9007199254740991 (`Number.MAX_SAFE_INTEGER`) is a `syntax` error, with
  the offset of its first digit: `d6ko9007199254740993`, `4d6kh99999999999999999999`.
- `dist/index.js` ships without comments: 43.2 kB, 10.5 kB gzipped. The doc comments are in
  `dist/index.d.ts`. 1.1.0 was 43.2 kB, 12.3 kB gzipped, with comments.
- Under an outermost `c`, each subtotal is the count of its name's surviving faces, matching
  `total`. Under `s` and `i` subtotals are sums.
- `explainDice` reads a leading minus as a negation (`-d6`: "Roll 1d6, negate the result.") and
  writes colors as the formula wrote them (`#red`, not `#cc3333`).

### Fixed

- An unbounded explosion or until-reroll that can reach a die whose every face meets its trigger
  throws `endless-trigger` when other dice share its group: `(d[3,3]+d6)!`, `(d[1,1]+d6)rru1`. A
  die a filter must drop, or a clamp keeps under the trigger, does not count: `(d[3,3]dh1+d6)!`
  and `d[3,3]max2!` roll. The first two validated, then threw `limit-chain` whenever that die
  triggered; `d[3,3]max2!` threw `endless-trigger`.
- A name's subtotal takes the name's first explicit color in reading order, also when a filter
  drops the face that wrote it. It took the first surviving face's color.
- A string face's positional value is capped by `limits.value` like a written value. It was not
  capped.
- A vertical explosion past exact integer range throws `result-too-large` under `c` too. It
  returned a rounded face.
- Pools and face lists as large as raised `draws` and `faces` limits allow roll and validate. They
  threw a native `RangeError` from a call-stack overflow.
- `DiceError.expected` lists tokens for an error after a `@name` variable. It was absent.
- `compileDice` reads `random` and `autoColor` when compiling, like its other options: changing the
  options object afterwards changes no roll. They were read on every roll.
- A `#name` color resolves only from the palette's own string values: `d6{#constructor}` throws
  `unknown-color`. It returned a function as the color.
- A trigger an earlier operator can reach is live: `d6min7!o7`, `(d6*)!o8` and `d6*rro7` roll.
  They threw `dead-trigger`.
- `limits: null` is the same as leaving `limits` out. It threw `TypeError`.
- Results never hold `-0`: a negated zero face, `-0`, and a division rounding to zero all read
  as `0`. They read as `-0`.

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
