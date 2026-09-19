# Changelog

Changes to the published package. Dates are npm publish dates. Every example here comes from a run
against the version it names.

## Unreleased

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

### Added

- The README records what the module weighs — 33.5 kB, 9.3 kB gzipped, 8.1 kB Brotli — beside the
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
