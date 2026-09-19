# rollatom

A dependency-free dice-notation engine for the web platform. It uses one grammar for rolling
dice, represents each rolled face with a record (the "RollAtom"), and leaves interpretation to
the table. The engine reports what came up; the table decides what it means.

Programmers may recognize a map/filter/reduce-style pipeline.

```
npm install rollatom
```

```ts
import { rollDice } from "rollatom";

rollDice("2d20kh1 + 5");                     // advantage, +5
rollDice("6d10ko8c");                        // count the 8-or-better successes
rollDice("10d[-1,0x6,1x3]");                 // net successes: 8+ counts one, 1s subtract one
rollDice("(2d8+3)s/2");                      // resistance: half the total, rounded down
rollDice("(1d12{'hope'} + 1d12{'fear'})i");  // two named d12s, listed individually
```

There is a [playground](https://xexiodev-boop.github.io/rollatom/) for trying formulas: it
validates as you type and rolls in the page.

RollAtom ships as ES modules only; there is no CommonJS build. The default RNG uses the Web
Crypto global (`crypto.getRandomValues`), so the supported runtimes are current browsers, web
workers, and Node 20 or later. Older Node versions work only with a custom `random` option. A
package manager is optional: see [Installing without npm](#installing-without-npm).

`rollDice(notation, options?)` returns a `NotationResult` with the total, surviving values,
per-face records (dropped dice included, marked), and name-grouped subtotals. `RollOptions`
configures the `random` source (a CSPRNG by default), the color `palette` for `#name` tokens,
and `autoColor` for named subtotals. For server-authoritative rolls, call `rollDice` in the
trusted environment and send its result to clients.

`validateDice(notation, options?)` checks a formula without rolling it and returns a `DiceError`
or `null`.

## Contents

- [Why RollAtom?](#why-rollatom)
- [Coming from Roll20 or Foundry](#coming-from-roll20-or-foundry)
- [Grammar at a glance](#grammar-at-a-glance)
- [Installing without npm](#installing-without-npm)
- [Calling the engine](#calling-the-engine)
  - [Where the error is](#where-the-error-is)
- [Reading the result](#reading-the-result)
  - [A face](#a-face)
  - [Names, subtotals, and modes](#names-subtotals-and-modes)
  - [A worked renderer](#a-worked-renderer)
- [Configuration](#configuration)
  - [Custom random source](#custom-random-source)
  - [Colors](#colors)
- [Validating without rolling](#validating-without-rolling)
- [Versioning](#versioning)

## Why RollAtom?

A roll is an array of faces: operators transform it, filters narrow it, and one reduction turns it
into a number. Every part of the grammar follows from that model instead of being a feature added
beside it.

- **One scheme rather than a list of features.** `k`/`d`/`r` keep, drop, or reroll; `h`/`l` select
  by rank; `o`/`u` select by value. The `o` that names an explosion trigger is the `o` that names a
  value filter, so combinations you have not seen before work.
- **The whole roll survives into the result.** Every face reports its raw roll, its sign, the die it
  came from, the chain an explosion added, and the rolls a reroll threw away. Faces a filter removed
  stay in the result marked as dropped, so an interface can show the die that was set aside
  ([Reading the result](#reading-the-result)).
- **Unusual dice are data, not engine support.** A weighted die, a narrative die, and a tens die are
  face lists (`d[-1,0x6,1x3]`, `d['cat','dog']`, `d[10..60:10]`). A system with strange dice needs
  nothing added to the roller.
- **A fixed draw order.** One formula and one generator always consume randomness in the same
  sequence, so a roll is reproducible and auditable. The generator is injectable and defaults to a
  CSPRNG, letting a server own the outcome while clients render it.
- **Impossible rolls fail before the dice.** An explosion that can never trigger, or one that could
  never stop, is rejected when the formula is read rather than discovered at the table.

The costs are deliberate. There is no arithmetic beyond the reduction, which may be multiplied or
divided once at the point the notation names it (`sx2`, `s/2`, `s/3u`); anything further belongs to
a macro layer. Nothing here knows what a success, a critical, or a degree of failure is. Word order
is fixed, so `6d6kh3!` is an error rather than a guess and exploding after a keep is written
`(6d6kh3)!`. And familiar spellings brought from another roller can parse cleanly while meaning
something else, which the next section lists.

## Coming from Roll20 or Foundry

Most notation carries over unchanged: `2d20kh1`, `4d6dl1`, `3d6!`, and `4dF` mean here what they
mean there. Four spellings look familiar but are not:

| Spelling | Elsewhere | In RollAtom |
|---|---|---|
| `!!` | compounding explosion, unbounded (Roll20, rpg-dice-roller) | **one** extra layer, appended as its own face. The compounding one is `*` |
| `*` | multiplication (`1d8*2`) | vertical explosion, unbounded. To scale a total, write `1d8sx2` ([Final operators](docs/GRAMMAR.md#final-operators-reducing-the-array)) |
| `ro` | reroll **once** (Roll20, Foundry, rpg-dice-roller) | reroll dice **over** a threshold. Reroll-once-under is `ru` ([Operators](docs/GRAMMAR.md#operators-clamp-explosion-reroll)) |
| `s` | sort (rpg-dice-roller) | **sum**, the default reduction. RollAtom does not sort; `i` keeps roll order |

Common rolls side by side:

| Roll | Elsewhere | Here |
|---|---|---|
| exploding pool | `3d6!` (Roll20), `3d6x` (Foundry) | `3d6!` |
| explode one layer only | `3d6xo` (Foundry) | `3d6!!` |
| compounding explosion | `3d6!!` (Roll20) | `3d6*` |
| reroll 1s and 2s, once each | `4d6ro<3` | `4d6ru2` |
| reroll 1s and 2s until they clear | `4d6r<3` | `4d6rru2` |
| success pool at 5 or better | `6d6>5` (Roll20), `6d6cs>=5` (Foundry) | `6d6ko5c` |
| half a modified total, rounded down | `floor((2d8+3)/2)` | `(2d8+3)s/2` |
| percentile | `d%` | `d100` |

The letter scheme behind the second table is uniform: `k`/`d`/`r` keep, drop, or reroll; `h`/`l`
select by rank; `o`/`u` select by value, over or under ([Filters](docs/GRAMMAR.md#filters-keeping-and-dropping)).
There is no general arithmetic and no comparison operator: scaling a total is the reducer scale
`sx2` or `s/2` ([Final operators](docs/GRAMMAR.md#final-operators-reducing-the-array)), and success counting is a
value filter plus `c` ([Filters](docs/GRAMMAR.md#filters-keeping-and-dropping)).

The grammar follows. It is executable as `src/dice-notation.test.ts`, with property-based contract
tests in `src/notation-contract.test.ts`. The API reference resumes after
[Worked examples](docs/GRAMMAR.md#worked-examples).

## Grammar at a glance

The full specification lives in **[docs/GRAMMAR.md](docs/GRAMMAR.md)**: the EBNF, every rule, the
limits, and worked examples. This is the shape of it.

A formula is one or more **blocks** joined by `+` and `-`. A block is a die, then optional
**operators**, then optional **filters**, then an optional **final operator**. That order is fixed
and enforced, so `6d6kh3!` is an error; write `(6d6kh3)!`.

| Part | Spelling | Examples |
|---|---|---|
| **Dice** | `NdM`, `d[…]`, `dF` | `4d6`, `d[3..6]`, `d[10..60:10]`, `2d['cat','dog']`, `4dF` |
| **Appearance** | `{#color,'name'}` | `2d6{#red}`, `2d6{#red,'fire'}` |
| **Clamp** | `minN`, `maxN` | `4d6min2` |
| **Explode** | `!` `!!` `*` `**`, optional `oN`/`uN` trigger | `4d6!`, `1d6*`, `4d6!o5` |
| **Reroll** | `r` + `h`/`l`/`o`/`u`, `rr` for until | `4d6ru2`, `4d6rru1`, `4d6rl1` |
| **Filters** | `k`/`d` + `h`/`l`/`m`/`o`/`u` + N | `4d6dl1`, `2d20kh1`, `6d6ko4` |
| **Final** | `s`, `c`, `i`, with optional scale | `(2d8+3)s/2`, `6d6ko4c`, `(1d6+1d8)i` |

The letters compose rather than enumerate:

- `k` keep, `d` drop, `r` reroll. `h`/`l`/`m` select by rank (highest, lowest, middle); `o`/`u`
  select by value (over, under). `rr` rerolls until the condition no longer holds.
- `!` explodes **horizontally**, appending a new face; `*` explodes **vertically**, summing into the
  exploding die's own seat. Doubling either (`!!`, `**`) limits it to one extra layer.
- `s` sums, `c` counts the survivors, `i` lists them. A scale rides on `s` and `c`: `xN` multiplies,
  `/N` divides rounding down, `/Nu` divides rounding up.

```ts
rollDice("4d6dl1");                  // drop the lowest of four
rollDice("2d20kh1 + 5");             // advantage, +5
rollDice("6d10ko8c");                // count the 8-or-better successes
rollDice("(2d8+3)s/2");              // half the modified total, rounded down
rollDice("10d[-1,0x6,1x3]");         // a weighted narrative die
```

Coming from another roller, read [Coming from Roll20 or Foundry](#coming-from-roll20-or-foundry)
first: several spellings parse cleanly here and mean something different.

## Installing without npm

The published package is one ES module that imports nothing, so it also runs straight from a URL
or from a copy inside your own tree. Every route below loads the same file.

**From a CDN.** Any npm-backed CDN serves the built module. Pin the version, so a later release
cannot change what the page loads:

```html
<script type="module">
  import { rollDice } from "https://esm.sh/rollatom@1.0.0";

  console.log(rollDice("2d20kh1 + 5").total);
</script>
```

`https://cdn.jsdelivr.net/npm/rollatom@1.0.0/dist/index.js` and
`https://unpkg.com/rollatom@1.0.0/dist/index.js` serve the same module.

**Through an import map**, when application code should keep writing the bare name:

```html
<script type="importmap">
  { "imports": { "rollatom": "https://esm.sh/rollatom@1.0.0" } }
</script>
<script type="module">
  import { rollDice } from "rollatom";
</script>
```

**Vendored.** `dist/index.js` is a single file with no imports, so dropping it into a project
leaves nothing to resolve; keep `dist/index.d.ts` beside it for types. A TypeScript project can
copy `src/index.ts` instead and compile it with everything else, which is also the way to build
the library without installing anything: the file needs no plugins and no build step of its own.

**In Deno**, `npm:rollatom@1.0.0` and the esm.sh URL both resolve:

```ts
import { rollDice } from "npm:rollatom@1.0.0";
```

Whatever the route, the runtime must provide `crypto.getRandomValues`, or a `random` function has
to be supplied per call (see [Configuration](#configuration)). Nothing else is required.

## Calling the engine

```ts
import { rollDice, validateDice, DiceError } from "rollatom";
import type { NotationResult, NotationFace, RollOptions, RandomInt } from "rollatom";

const result = rollDice("4d6dl1");
```

`rollDice(notation, options?)` parses, rolls, and reduces in one call. It either returns a
complete [`NotationResult`](#reading-the-result) or throws `DiceError`. There is no partial result
and no error field to check:

```ts
try {
  render(rollDice(notation));
} catch (error) {
  if (error instanceof DiceError) showInvalid(notation);
  else throw error;
}
```

Branch on `instanceof DiceError`, never on the message text ([Versioning](#versioning)).

Errors fall into two groups, and the split decides where a caller has to handle them:

| Group | Raised | Covers | Caught by `validateDice`? |
|---|---|---|---|
| **Static** | at parse time, before a die is drawn | syntax, unknown `#color`, formula length, operand count, `i` placement, impossible and never-halting triggers, and the base dice a formula is certain to roll | Yes |
| **Roll-time** | mid-roll, as dice are drawn and reduced | the total draw cap, the 50-roll chain cap on a single face, and a result too large to hold exactly | No |

An input field can therefore call [`validateDice`](#validating-without-rolling) on every keystroke
and still needs a `try` around `rollDice` ([Limits and safety](docs/GRAMMAR.md#limits-and-safety)).

### Where the error is

A `DiceError` raised while reading the formula carries **`index`**, a 0-based offset into the
notation exactly as passed in, so an input field can point at the character that failed:

```ts
const error = validateDice(notation);
if (error) {
  const caret = error.index === undefined ? "" : " ".repeat(error.index) + "^ ";
  console.log(notation + "\n" + caret + error.message);
}
```

```
6d6kh3!
      ^ Invalid notation
(2d6)sx3/2
        ^ Invalid notation
d6!o7
  ^ Explosion can never trigger
1d6 + (2d6i) + 3
          ^ `i` must be the outermost reduction
```

`index` marks the **start of the offending token**, not wherever scanning stopped: `2000d6` points
at the count and `2d6{'unclosed}` at the opening quote, not at the character that finally gave up.
When the input simply runs out, it is one past the end, so `(2d6` gives 4.

It is `undefined` for the failures no single character causes: the formula-wide draw cap
(`60d6 + 60d6` counts base dice across every block), the length cap, and the caps only a roll can
reach. Treat it as absent-by-default and the caret as an enhancement.

**The same formula gives a different result every call.** The default source is a CSPRNG. Pass
`random` to replay a roll ([Custom random source](#custom-random-source)); for a given formula the
draw order is fixed ([Determinism](docs/GRAMMAR.md#determinism)), so a recorded seed reproduces the roll exactly.

**For server-authoritative rolls**, call `rollDice` in the trusted environment and send the result
to clients. A `NotationResult` is plain data: it survives `JSON.stringify` and `JSON.parse`
unchanged, and carries everything a renderer needs, so a client never re-parses or re-rolls.

## Reading the result

A result is the array of faces from [The one idea](docs/GRAMMAR.md#the-one-idea), plus the reduction over it.
Rolling `4d6dl1` against a source that yields 5, 2, 6, 3:

```json
{
  "notation": "4d6dl1",
  "total": 14,
  "values": [5, 6, 3],
  "mode": "sum",
  "faces": [
    { "value": 5, "sign": 1, "raw": 5, "history": [5], "faces": 6 },
    { "value": 2, "sign": 1, "raw": 2, "history": [2], "faces": 6, "dropped": true },
    { "value": 6, "sign": 1, "raw": 6, "history": [6], "faces": 6 },
    { "value": 3, "sign": 1, "raw": 3, "history": [3], "faces": 6 }
  ]
}
```

`values` and `faces` answer different questions. **`values` is the arithmetic**: the surviving
faces, signed, in roll order, and exactly what `total` reduces. **`faces` is the picture**: every
die the formula touched, the ones filters removed included, marked `dropped` and contributing
nothing. A renderer that reads only `values` has no way to dim the die that lost.

| Field | Type | Present | Holds |
|---|---|---|---|
| `notation` | `string` | always | the formula as passed in |
| `total` | `number` | always | the reduction, with any `scale` already applied |
| `values` | `number[]` | always | surviving face values, signed, in roll order |
| `faces` | `NotationFace[]` | always | every face, dropped ones included |
| `mode` | `"sum"`, `"count"`, `"individual"` | always | the outermost reduction |
| `labels` | `string[]` | when any face carries a name or is a string face, and always under `i` | per-face display text, positionally parallel to `values` |
| `subtotals` | `NotationSubtotal[]` | when any face carries a name | per-name totals, in first-appearance order |
| `scale` | `NotationScale` | when the outermost reducer carries one | the `xN` or `/N` that `total` already includes |

**`scale` is the one trap.** `total` has it applied and `values` do not, so a renderer that sums
`values` itself will disagree with `total`. `(2d6)sx2` on 3 and 4 gives `values: [3, 4]`,
`scale: { "op": "x", "by": 2 }`, and `total: 14`. Show `total`, or apply `scale` yourself.

### A face

| Field | Type | Present | Holds |
|---|---|---|---|
| `value` | `number` | always | `sign` times `raw`: this face's contribution to `total` |
| `sign` | `1` or `-1` | always | `-1` only for a face joined by `-` |
| `raw` | `number` | always | the number the die shows, before `sign` |
| `history` | `number[]` | always | the raw rolls behind `raw`. Empty for constants and seals |
| `rerolls` | `number[]` | when the face rerolled | the raw rolls a reroll operator discarded, in order |
| `faces` | `number` | rolled dice only | the source die's face count, for picking an icon |
| `label` | `string` | labeled faces | the face's own text: a Fate `+`, a `d['cat','dog']` side |
| `name` | `string` | named dice | the name the die carries, which drives subtotals |
| `color` | `string` | colored dice | the resolved hex color |
| `sealed` | `true` | sealed faces | produced by an `s` or `c` seal: sourceless, but not a constant |
| `dropped` | `true` | filtered faces | kept in `faces`, absent from `values` and `total` |

Three distinctions are worth reading closely, because the types alone do not give them away.

**`raw` is not "the unsigned value".** `sign` comes only from a `-` in the formula, so a face list
holding negative numbers puts them in `raw`: one `dF` reading minus has `raw: -1` and `sign: 1`,
while the d4 in `2d6 - 1d4` has `raw: 3` and `sign: -1`. To show the die as it landed, read `raw`;
to do arithmetic, read `value`.

**`history` distinguishes the two explosions.** A horizontal explosion adds faces to the array, so
`1d6!` on 6, 6, 2 returns *three* faces, each with its own single-entry `history`. A vertical
explosion sums the chain into one face, so `1d6*` on the same rolls returns *one* face with
`raw: 14` and `history: [6, 6, 2]`. Rendering `history` when it holds more than one entry is what
shows the chain that built the number.

**A face with no `faces` field came from no die.** A constant has `history: []` and nothing else; a
seal has `history: []` and `sealed: true`. Both still occupy a slot in `values`.

### Names, subtotals, and modes

A named die groups: every face sharing a name contributes to one entry in `subtotals`, colored by
the die's own color or, without one, by `autoColor` ([Colors](#colors)).
`2d6{#red,'fire'} + 1d8{'ice'}` on 3, 4, 7 produces subtotals of `fire: 7` (`#cc3333`, the
palette's red) and `ice: 7` (an auto color), with `total: 14` unchanged. Subtotals describe the
roll; they never change the arithmetic.

`mode` says how to present `total`:

| `mode` | From | `total` is | Typical rendering |
|---|---|---|---|
| `sum` | implicit, or `s` | the sum of `values` | the number |
| `count` | `c` | how many faces survived | "3 hits" |
| `individual` | `i` | still the sum, usually ignored | each face listed separately |

Under `i`, `labels` is always present, and an unnamed face's label is simply its value as a string.
A label is therefore worth showing only when it differs from the value beside it.

### A worked renderer

Everything above, as one function over a result:

```ts
function describe(result: NotationResult): string {
  const lines: string[] = [];

  for (const face of result.faces) {
    const source = face.faces ? `d${face.faces}` : face.sealed ? "seal" : "const";
    const chain = face.history.length > 1 ? ` = ${face.history.join(" + ")}` : "";
    const rerolled = face.rerolls ? ` (rerolled ${face.rerolls.join(", ")})` : "";
    const shown = face.label ?? String(face.value);
    lines.push(
      `  ${face.dropped ? "-" : "*"} ${source} ${shown}${chain}${rerolled}` +
        `${face.name ? ` [${face.name}]` : ""}${face.color ? ` ${face.color}` : ""}`
    );
  }

  for (const sub of result.subtotals ?? []) lines.push(`  ${sub.label}: ${sub.total}`);

  if (result.mode === "count") lines.push(`  ${result.total} hits`);
  else if (result.mode === "individual") {
    // Under `i`, an unnamed face's label is just its value, so only add a label that says more.
    const parts = result.values.map((value, i) => {
      const label = result.labels?.[i];
      return label && label !== String(value) ? `${label} ${value}` : String(value);
    });
    lines.push(`  ${parts.join(", ")}`);
  } else lines.push(`  total ${result.total}`);

  return lines.join("\n");
}
```

Against seeded rolls it prints:

```
4d6dl1                              1d6*
  * d6 5                              * d6 14 = 6 + 6 + 2
  - d6 2                              total 14
  * d6 6
  * d6 3                            4d6ru2
  total 14                            * d6 6 (rerolled 1)
                                      * d6 5
6d6ko4c                               * d6 3 (rerolled 2)
  * d6 5                              * d6 4
  - d6 2                              total 18
  * d6 6
  - d6 3                            (1d12{'hope'} + 1d12{'fear'})i
  * d6 6                              * d12 9 [hope]
  - d6 1                              * d12 4 [fear]
  3 hits                              hope: 9
                                      fear: 4
2d6{#red,'fire'} + 1d8{'ice'}         hope 9, fear 4
  * d6 3 [fire] #cc3333
  * d6 4 [fire] #cc3333
  * d8 7 [ice]
  fire: 7
  ice: 7
  total 14
```

A real renderer swaps the `*` and `-` markers for styling and `faces` for a die icon, but the
shape is this: walk `faces` to draw, read `subtotals` to group, and switch on `mode` for the
headline.

## Configuration

Options are supplied per call. RollAtom has no mutable global configuration.

| Option | Type | Default | Purpose |
|---|---|---|---|
| `random` | `(faceCount: number) => number` | Web Crypto CSPRNG | Selects a face for every base roll, explosion, and reroll |
| `palette` | `Record<string, string>` | `DEFAULT_PALETTE` | Resolves named color tokens such as `#red` |
| `autoColor` | `(label: string) => string` | Stable color derived from the label | Colors named subtotals that have no explicit color |

### Custom random source

The default generator uses `crypto.getRandomValues()` with rejection sampling to avoid modulo
bias. It does not use `Math.random()`.

A custom generator can wrap another cryptographic library, a seeded generator, hardware, or
prefetched remote randomness:

```ts
import { rollDice, type RollOptions } from "rollatom";

const options: RollOptions = {
  random(faceCount) {
    return myRandom.uniformInteger(1, faceCount);
  },
};

const result = rollDice("4d6!", options);
```

`random` is synchronous and must return an integer from 1 through `faceCount`, inclusive. The
number is a **1-based face index**, not necessarily the value printed on that face. For
`d[10,20,30]`, indices 1, 2, and 3 select values 10, 20, and 30. RollAtom throws `DiceError` if
the callback returns zero, a fraction, or an out-of-range value. The custom generator is
responsible for producing an unbiased distribution. An asynchronous or remote source must
prefetch its values and expose them through the synchronous callback.

The callback is invoked once for every random draw, including explosion and reroll draws. Draw order
is deterministic for a given formula, as specified in [Limits and safety](docs/GRAMMAR.md#limits-and-safety).

### Colors

`palette` maps named tokens to the color metadata returned on faces and subtotals. Palette keys
should be lowercase because color tokens are case-insensitive. A 3- or 6-digit hex token such
as `#f0f` or `#ff00aa` does not use the palette.

Supplying `palette` replaces the default palette. Extend `DEFAULT_PALETTE` when the standard
names should remain available:

```ts
import { DEFAULT_PALETTE, rollDice, type RollOptions } from "rollatom";

const options: RollOptions = {
  palette: {
    ...DEFAULT_PALETTE,
    brand: "#7950f2",
    danger: "#e03131",
  },
  autoColor(label) {
    return label === "fire" ? "#e8590c" : "#495057";
  },
};

const result = rollDice("2d6{#brand,'attack'} + 1d8{'fire'}", options);
```

An explicit color is returned as `NotationFace.color` and is shared with colorless dice that have
the same name ([Appearance](docs/GRAMMAR.md#appearance)). `autoColor` applies only to a named subtotal with no
explicit color; it does not assign a color to the individual faces. The default `autoColor` returns
the same color for the same label.

`RollOptions` currently contains only `random`, `palette`, and `autoColor`. Grammar limits and
safety caps are not per-call options; they are fixed, described in
[Limits and safety](docs/GRAMMAR.md#limits-and-safety), and readable through the frozen `LIMITS` export.

## Validating without rolling

`validateDice` runs the parse phase and draws no dice. It returns the `DiceError` the same input
would throw, or `null`. Use it for an input field that should reject a bad formula as it is
typed, or to check macros before storing them:

```ts
import { validateDice } from "rollatom";

validateDice("2d20kh1 + 5");  // null
validateDice("6d6kh3!");      // DiceError: Invalid notation (operators may not follow filters)
validateDice("d6!o7");        // DiceError: Explosion can never trigger
validateDice("60d6 + 60d6");  // DiceError: Too many dice (more base dice than the draw cap allows)
```

It applies every static check `rollDice` makes: syntax, formula length, operand count, `i` placement
([Combining blocks](docs/GRAMMAR.md#combining-blocks-constants-and-groups)), impossible and never-halting triggers
([Limits and safety](docs/GRAMMAR.md#limits-and-safety)), and the total base dice a formula is certain to roll.
Only `palette` is read from the options, because `#name` tokens must resolve against the palette the
roll will use; passing the roll's own `RollOptions` object is fine.

Three limits are checked during the roll rather than against the text, so a validated formula can
still fail at roll time: the total-draw cap once explosions and rerolls have drawn, the 50-roll
chain cap on a single face, and a seal or total that nested scales push past the integers a number
holds exactly ([Limits and safety](docs/GRAMMAR.md#limits-and-safety)). Calling `validateDice`
first does not remove the need to handle `DiceError` from `rollDice`.

## Versioning

RollAtom follows semantic versioning from 1.0.0. The contract is the set of exports this document
describes -- `rollDice`, `validateDice`, `DiceError`, `LIMITS`, `DEFAULT_PALETTE`, and the
`NotationResult`, `NotationFace`, `NotationSubtotal`, `NotationScale`, `RollOptions`, `Limits`, and
`RandomInt` types -- together with the grammar itself. A formula that rolls under 1.0 keeps rolling
under every later 1.x, and keeps the same shape of result.

Three clarifications on what that covers:

- **The caps in [`LIMITS`](docs/GRAMMAR.md#limits-and-safety) may rise in a minor release, never fall.** Raising
  one only admits formulas that were previously rejected; lowering one would reject formulas that
  used to roll, so it waits for a major.
- **Rolled numbers are not covered, but the draw order is.** The default RNG is a CSPRNG, so
  results vary by design. What stays fixed within 1.x is the sequence described in
  [Determinism](docs/GRAMMAR.md#determinism): a given formula draws from `random` in the same order, so a recorded
  seed replays to the same roll.
- **ES modules only is part of the promise.** There is no CommonJS build, and 1.x will not add one.
- **`DiceError` message text is not covered.** Which formulas are rejected is part of the grammar
  and will not change within 1.x, but the wording explaining why may be sharpened in any release.
  Branch on `instanceof DiceError`, never on the message string.
  The same applies to a `DiceError`'s `index`: that a positional error *has* one is covered, but
  the exact offset may move as messages are sharpened. It is for drawing a caret, not comparing.

Additions are minor releases: new grammar that was previously a `DiceError`, new optional fields on
the result, new optional `RollOptions`. If a formula that rolled correctly stops rolling, or its
result changes shape, that is a bug rather than a deliberate change.
