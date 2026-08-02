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
- [The grammar](#the-grammar)
  - [The one idea](#the-one-idea)
  - [Grammar (EBNF)](#grammar-ebnf)
  - [Blocks and faces](#blocks-and-faces)
  - [Appearance](#appearance)
  - [Operators: clamp, explosion, reroll](#operators-clamp-explosion-reroll)
  - [Filters: keeping and dropping](#filters-keeping-and-dropping)
  - [Final operators: reducing the array](#final-operators-reducing-the-array)
  - [Combining blocks, constants, and groups](#combining-blocks-constants-and-groups)
  - [Order and errors](#order-and-errors)
  - [Limits and safety](#limits-and-safety)
  - [Worked examples](#worked-examples)
- [Installing without npm](#installing-without-npm)
- [Configuration](#configuration)
- [Validating without rolling](#validating-without-rolling)

## Why RollAtom?

A roll here is an array of faces: operators transform it, filters narrow it, and one reduction
turns it into a number. Every part of the grammar follows from that model instead of being a
feature added beside it.

What that buys:

- **One scheme rather than a list of features.** `k`/`d`/`r` keep, drop, or reroll; `h`/`l`
  select by rank; `o`/`u` select by value. The `o` that names an explosion trigger is the `o`
  that names a value filter. Combinations you have not seen before work, because they are the
  same few rules meeting.
- **The whole roll survives into the result.** Every face reports its raw roll, its sign, the die
  it came from, the chain an explosion added, and the rolls a reroll threw away. Faces a filter
  removed stay in the result marked as dropped, so an interface can show the die that was set
  aside instead of pretending it never landed.
- **Unusual dice are data, not engine support.** A weighted die, a narrative die, and a tens die
  are face lists (`d[-1,0x6,1x3]`, `d['cat','dog']`, `d[10..60:10]`). A system with strange dice
  needs nothing added to the roller.
- **A fixed draw order.** One formula and one generator always consume randomness in the same
  sequence, which makes a roll reproducible and auditable. The generator is injectable and
  defaults to a CSPRNG, so a server can own the outcome and clients can render it.
- **Impossible rolls fail before the dice.** An explosion that can never trigger, or one that
  could never stop, is rejected when the formula is read rather than discovered at the table, and
  `validateDice` runs those checks on their own.
- **Presentation without interpretation.** Names and colors ride along and group into subtotals.
  The engine works them out and leaves every rendering decision to the application.

What it costs:

- **No arithmetic beyond the reduction.** There is no `d6*5`, no rounding function, no decimal or
  dice-valued factor. A reduction can be multiplied or divided once, at the point the notation
  names it (`sx2`, `s/2`, `s/3u`). Anything further belongs to a macro layer above the roller.
- **No rules.** Nothing here knows what a success, a critical, or a degree of failure is. A pool
  can be counted (`6d6ko5c`), but deciding what the count means is yours. A system that wants its
  roller to answer "did I hit?" needs that layer written on top.
- **Word order is fixed.** Operators, then filters, then the reduction. `6d6kh3!` is an error
  rather than a guess at what you meant, and exploding after a keep must be written `(6d6kh3)!`.
  The precision costs a pair of parentheses.
- **Familiar spellings can mean other things.** Notation brought from another roller may parse
  cleanly and produce the wrong roll instead of an error, so stored macros need translating
  rather than copying. The next section lists the traps.
- **Hard caps.** 100 draws per formula, 50 chained rolls on one face, 200 characters, 20 operands.
  They keep a pathological formula from hanging, and they also refuse a genuinely enormous pool.
- **Integers and ES modules only.** Rounding is spelled at the reduction, there is no CommonJS
  build, and the default generator expects Web Crypto.

## Coming from Roll20 or Foundry

Most notation carries over unchanged: `2d20kh1`, `4d6dl1`, `3d6!`, and `4dF` mean here what they
mean there. Four spellings look familiar but are not:

| Spelling | Elsewhere | In RollAtom |
|---|---|---|
| `!!` | compounding explosion, unbounded (Roll20, rpg-dice-roller) | **one** extra layer, appended as its own face. The compounding one is `*` |
| `*` | multiplication (`1d8*2`) | vertical explosion, unbounded. To scale a total, write `1d8sx2` ([Final operators](#final-operators-reducing-the-array)) |
| `ro` | reroll **once** (Roll20, Foundry, rpg-dice-roller) | reroll dice **over** a threshold. Reroll-once-under is `ru` ([Operators](#operators-clamp-explosion-reroll)) |
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
select by rank; `o`/`u` select by value, over or under ([Filters](#filters-keeping-and-dropping)).
There is no general arithmetic and no comparison operator: scaling a total is the reducer scale
`sx2` or `s/2` ([Final operators](#final-operators-reducing-the-array)), and success counting is a
value filter plus `c` ([Filters](#filters-keeping-and-dropping)).

The grammar follows. It is executable as `src/dice-notation.test.ts`, with property-based contract
tests in `src/notation-contract.test.ts`. The API reference resumes after
[Worked examples](#worked-examples).

## The grammar

A single grammar describes dice rolls across different game systems. Each system is expressed
as a formula instead of a special-purpose engine.

## The one idea

**Everything is an array of rolled faces, reduced at the end.**

When you roll dice at a physical table, you end up with visible faces that you group and
interpret. RollAtom models this as an array of face records that operators transform, filters
select, and a final operator reduces.

1. A **block** rolls dice and produces an **array of faces**. Each face carries a **raw roll**, a
   **sign** (±1, set by `-`; see [Combining blocks](#combining-blocks-constants-and-groups)), and
   its **value** = sign × raw. Two optional attributes ride along: a **source** (the die's face set,
   which fresh rolls draw from) and an **appearance** (name and color; see
   [Appearance](#appearance)). A rolled face has both; a constant has neither; a sealed face
   ([Combining blocks](#combining-blocks-constants-and-groups)) keeps at most an appearance.
2. **Operators** (`!`, `min`, `ru`, …) mutate that array by adding faces or replacing raw rolls.
   They act only on faces with a source, and always read and write the raw roll
   ([Operators](#operators-clamp-explosion-reroll)).
3. **Filters** (`kh`, `do`, …) select a sub-array, always comparing values
   ([Filters](#filters-keeping-and-dropping)).
4. A **final operator** (`s`, `c`, `i`) reduces the array to the output.
5. `+` and `-` **concatenate** arrays (`-` flips the sign of the faces it joins; see
   [Combining blocks](#combining-blocks-constants-and-groups)), and the whole formula is reduced by
   an implicit sum.

The grammar does not define a "success", a "critical", or a "degree." A move can use `2d6`,
with the result interpreted by the table. Different systems express how their dice are rolled
and reduced through formulas rather than specialized engines.

## Grammar (EBNF)

```ebnf
formula     = expr

expr        = [ "-" ] operand { ( "+" | "-" ) operand }

operand     = group | block | constant

group       = "(" expr ")" [ operators ] [ filters ] [ final ]

block       = [ UINT ] "d" faces [ appearance ] [ operators ] [ filters ] [ final ]

constant    = UINT                              ; a single face, no die identity

faces       = UINT                              ; dN  ==  d[1..N]     (N in 2..1000)
            | "f"                               ; dF  ==  d['-'=-1, ''=0, '+'=1]
            | "[" facelist "]"
facelist    = element { "," element }           ; expands to 2..100 faces, no trailing comma
element     = face [ "x" UINT ]                 ; a face, optionally repeated
            | INT ".." INT [ ":" UINT ]         ; an ascending range, optional step; no "x"
face        = INT                               ; numeric face: its literal value
            | STRING [ "=" INT ]                ; string face: value = INT, else 1-based position

appearance  = "{" appspec { "," appspec } "}"   ; order-free; at most one color + one name
appspec     = color | STRING
color       = "#" NAME                          ; a palette color, e.g. #red
            | "#" HEX3 | "#" HEX6               ; a hex color, e.g. #f0f or #ff00aa

operators   = { clamp | explode | reroll }      ; applied left-to-right, before any filter;
                                                ; at most one explode per block or group
clamp       = ( "min" | "max" ) INT
explode     = ( "!" | "!!" | "*" | "**" ) [ "o" INT ]
reroll      = ( "ru" | "ro" ) INT               ; by value threshold, once
            | ( "rru" | "rro" ) INT             ; by value threshold, until it stops qualifying
            | ( "rl" | "rh" ) UINT              ; by rank count

filters     = { filter }                        ; applied left-to-right, after all operators
filter      = ( "kh" | "kl" | "km"
              | "dh" | "dl" ) [ UINT ]          ; by rank count (default 1, clamps)
            | ( "ko" | "ku"
              | "do" | "du" ) INT               ; by value threshold

final       = ( "s" | "c" ) [ scale ] | "i"     ; at most one; default is s

scale       = "x" UINT                          ; multiply the reduction
            | "/" UINT [ "u" ]                  ; divide it, rounding down; "u" rounds up

UINT        = digit { digit }                   ; a count; must be 1 or more, zero is an error
INT         = [ "-" ] digit { digit }           ; a signed value; zero allowed
```

Whitespace is insignificant except inside a `STRING`. It may separate tokens but never split one (`1
0d6` is not `10d6`). The lexer is **greedy**: `!!!` reads as `!!` then `!`. The one-explosion rule
([Operators](#operators-clamp-explosion-reroll)) rejects it, just as it rejects `! !` as two
separate tokens. Keywords, die letters, and color names are case-insensitive; the contents of a
quoted `STRING` are kept exactly as written. Control characters (C0 and DEL) are therefore rejected
inside strings.

The **canonical order inside a block is fixed**: `count · d · faces · appearance · operators ·
filters · final`. Writing them out of order is a syntax error, not a silent reorder (see
[Order and errors](#order-and-errors)).

## Blocks and faces

`d` is always **infix**: a count on the left, a face specification on the right.

| Form | Meaning |
|---|---|
| `d6` | one six-sided die; sugar for `d[1,2,3,4,5,6]` |
| `4d8` | four eight-sided dice |
| `dF` | one Fate/Fudge die; sugar for `d['-'=-1, ''=0, '+'=1]` |
| `d[1,2,3]` | one die with three faces valued 1, 2, 3 |
| `d[-1,0,1]` | one die reading −1, 0, or +1 |
| `d[3..6]` | one die with faces 3, 4, 5, 6, distributed uniformly unlike `d6min3` |
| `d[10..60:10]` | a stepped range: faces 10, 20, 30, 40, 50, 60 |
| `d[-1,0x6,1x3]` | repetition: one −1 face, six 0 faces, three 1 faces |
| `4d['cat','dog']` | four dice, each reading `cat` (1) or `dog` (2) |
| `2d['crit'=20,'hit'=10,'miss'=0]` | two dice with named, custom-valued faces |

Rules for a face list:

- **Numeric faces are literal values.** `d[10,20]` rolls 10 or 20.
- **String faces default to their 1-based position.** `['cat','dog']` → cat = 1, dog = 2. An
  explicit `= INT` overrides it: `['cat'=-12,'dog']` → cat = −12, dog = 2.
- **String faces must be quoted;** a bare token is a number. Values may repeat
  (`['heads'=1,'tails'=1]`). A trailing comma is an error.
- **A range `A..B` expands to every value from A to B**, ascending; an optional `:STEP` (a count, ≥
  1) walks in strides, including only values up to B (`[1..10:3]` is {1, 4, 7, 10}; `[1..9:3]` is
  {1, 4, 7}). A descending range is an error, not a silent reorder. Ranges are numeric only and mix
  freely with other elements (`[1..3,5]`).
- **`x N` repeats the preceding face N times** as a shorthand for weighted faces (`[-1,0x6,1x3]`).
  It applies to a single face, never to a range (`[1..3x2]` is an error). A repeated *string* face
  is literal sugar for writing it out, so positional defaults count the expanded positions
  (`['a'x2,'b']` values the copies 1, 2 and `b` 3); pair repetition with an explicit `=` when the
  copies must share a value (`['miss'=0x4,'hit'=1x2]`).
- A face list holds **2 to 100 faces**, counted and value-capped *after* ranges and repetitions
  expand. One-face dice are rejected like `d1`; use a constant instead.
- The **die's value domain** is the set of its face values; its **maximum face** is the highest of
  those values (the default explosion trigger, [Operators](#operators-clamp-explosion-reroll)).

Face lists are also how positional dice are built: `d66` is a sixty-six-sided die, so the
tens-and-units d66 of many games is spelled with a face list: `d[10..60:10] + d6`
([Worked examples](#worked-examples)).

## Appearance

Color and name make up a face's **appearance**. They attach **only to a die block's core**,
immediately after the faces, in `{…}`. They never affect the math.

| Form | Meaning |
|---|---|
| `2d6{#red}` | two d6 drawn red |
| `2d6{'necrotic'}` | two d6 named *necrotic* |
| `2d6{#red,'necrotic'}` | red, named *necrotic* |
| `2d6{#ff00aa}` | a hex color |

- A **color** is `#`-prefixed: `#red` (a palette name) or `#f0f` / `#ff00aa` (3- or 6-digit hex).
  The `#` is what marks the token as a color. An unknown palette name is an error.
- A **name** is a quoted string. `#red` is the color while `'red'` is a die *named* "red".
- Because both are self-marking, **order does not matter** and each may appear at most once.
- Appearance is illegal on a group or a constant: `(2d6+d8){#red}` and `3{#red}` are errors.

Color is metadata only. The engine exposes resolved colors through the `color` fields on result
faces and subtotals; the calling application decides whether and how to render them.

**A name's color applies throughout the roll.** An explicit color on a named block paints every
colorless block with the same name, anywhere in the formula. In
`1d6{'fire',#red} + 1d8{'fire'}`, both dice are red. A block with its own explicit color keeps
it. Conflicts stay as written. When a name carries more than one explicit color, the first in
reading order is used for the name and its subtotal. Color never crosses names, and
a bare `{#red}` with no name paints only its own block.

When the final operator is a sum, the engine reports the grand total **and** a breakdown grouped by
**name**: every named face joins its name's subtotal, colored by the name's color as above
(or the name's automatic color when no explicit color appears). Color without a name is
paint only; it never creates a subtotal. For example, `2d6{'fire'} + 1d4{'cold'}` shows a fire
subtotal and a cold subtotal.

## Operators: clamp, explosion, reroll

Operators mutate the array. They are applied left-to-right and always **before** any filter, so
a later operator sees everything an earlier one did. Two uniform rules:

- Operators act only on faces with a **source**. Constants and sealed faces
  ([Combining blocks](#combining-blocks-constants-and-groups)) cannot explode, be rerolled, or be
  clamped, so `(2d6+3)!` leaves the 3 alone.
- Operators read and write the **raw roll**, never the signed value. The sign a face was joined with
  ([Combining blocks](#combining-blocks-constants-and-groups)) survives every operator untouched: in
  `(2d8 - 2d4)ru2` a d4 showing 2 rerolls. It is selected by its raw 2, not its value −2, and the
  fresh roll still subtracts. `(-d6)ru0` rerolls nothing because a raw roll is never 0 or less.
  Filters are the opposite: they always compare values ([Filters](#filters-keeping-and-dropping)).

### Clamp

`minN` raises every raw roll below N to N; `maxN` lowers every raw roll above N to N.
For example, "treat 1s and 2s as 3" is `min3`. Clamping is equivalent to a shifted face list:
`4d6min3` rolls like `4d[3,3,3,4,5,6]` without requiring the caller to list the faces.

Because operators run left-to-right, order against an explosion matters: `2d6max5!` clamps
first, so no face can show the trigger and nothing explodes; `2d6!max5` explodes first, then
flattens the result.

### Explosion

Explosion triggers when a die's **raw roll** shows its **trigger value or more**. The default
trigger is the die's **maximum face**; an optional `oN` suffix moves it to "N or more". This is the
same `o` as the value filters ([Filters](#filters-keeping-and-dropping)), which is what World of
Darkness calls 9-again (`d10!o9`). The direction is chosen by the glyph:

| Glyph | Direction | Effect on the array | Unbounded? |
|---|---|---|---|
| `!` | **horizontal** | each triggering die rolls a new die, **appended as a new face** | yes; spawns keep exploding |
| `!!` | horizontal | appends one new face per triggering die | no; the spawn is inert |
| `*` | **vertical** | extra rolls **sum into the exploding die's own seat** | yes; rolls continue while they trigger |
| `**` | vertical | one extra roll sums into the seat | no |

A **single glyph is unbounded**, subject to the safety cap in
[Limits and safety](#limits-and-safety). This matches the usual meaning of `!` in other engines.
**Doubling it limits** the explosion to a single extra layer. A block or group carries **at most one
explosion operator**: `2d6!*` is an error, and greedy lexing makes `2d6!!!` read as `!!` then `!`,
equally an error.

Every spawned or chained roll draws from the **exploding die's own source** and inherits its
sign, name, and color. A negated die spawns negated faces, and a vertical seat sums the chain's
raw rolls under the face's one sign, so subtotals still group correctly.

The array model has two useful consequences:

- **Count (`c`)** counts array elements, so `!`/`!!` raise the count (a success pool that grows),
  while `*`/`**` keep one die as one element.
- **Rank filters** see each horizontal spawn as its own face, but a vertical die as a single face
  carrying its summed total. `2d6*kh1` therefore keeps the biggest *exploded total*, while
  `2d6!kh1` keeps the biggest *single face*.

### Reroll

A reroll **replaces** a die's value in place; the array length never changes.

| Form | Rerolls | Selected by |
|---|---|---|
| `ruN` | dice whose raw roll is **N or less** (under), **once** | value |
| `roN` | dice whose raw roll is **N or more** (over), **once** | value |
| `rruN` | dice whose raw roll is **N or less**, **until** it is not | value |
| `rroN` | dice whose raw roll is **N or more**, **until** it is not | value |
| `rlN` | the **N lowest** dice, once | rank |
| `rhN` | the **N highest** dice, once | rank |

Under the single-shot forms each selected die is rerolled **once**; the new value stands even
if it would still qualify. A reroll replaces the face's **whole raw roll** with a single fresh
roll of its source, including anything an earlier vertical explosion had summed into the seat.
The sign stays, and the discarded rolls are reported on the face (`rerolls`) so the trail
stays visible. Rank rerolls (`rl`/`rh`) rank by raw roll, like every operator. To reroll and
*then* explode the fresh value, seal the reroll in a group first: `(2d6rl1)*`.

The **until** forms (`rru`/`rro`) keep rerolling a selected die while the fresh roll still
qualifies, resolving one face's whole chain before the next face. `1d10rru1` rerolls 1s until none
remain. These forms preserve the die's identity and reroll history. Their terminal distribution
matches the corresponding restricted die: `d10rru1` matches `d[2..10]`, and rerolling the 0s of
`d[-1,0x6,1x3]` matches `d[-1,1x3]`. Only value thresholds are supported because a rank-based form
has no stopping condition. The static checks match those for unbounded explosions
([Limits and safety](#limits-and-safety)): a threshold no face can meet is invalid, as is one that
every face meets. The doubling convention differs from explosions: `rr` changes a single reroll to
an until-reroll, while `!!` changes an unbounded explosion to one layer.

## Filters: keeping and dropping

Filters run after all operators, left-to-right. Each returns an array of zero or more faces. Filters
always compare **values** (with the sign applied), while operators compare raw rolls
([Operators](#operators-clamp-explosion-reroll)). Before any `-` join the two are the same number,
so `2d8 - 2d4kh1` keeps the d4 that rolled highest; after one they differ, so `(2d8 - 2d4)kh1` keeps
the largest *contribution*. This is always one of the d8s, since the d4s contribute negatively.

| Form | Effect | Selected by |
|---|---|---|
| `khN` | keeps the **N highest** (default 1) | rank |
| `klN` | keeps the **N lowest** (default 1) | rank |
| `kmN` | keeps the **N middle** (default 1) | rank |
| `dhN` | drops the **N highest** (default 1) | rank |
| `dlN` | drops the **N lowest** (default 1) | rank |
| `koF` | keeps every die valued **F or more** (over) | value |
| `kuF` | keeps every die valued **F or less** (under) | value |
| `doF` | drops every die valued **F or more** | value |
| `duF` | drops every die valued **F or less** | value |

Drop filters remain useful when the pool size can change. After `6d6!`, explosions may add
faces:

- If `6d6!` produces six faces, `dl2` is equivalent to `kh4`.
- If it produces eight faces, `dl2` is equivalent to `kh6`.

Because the final pool size is not known in advance, no single `khN` can always replace `dl2`.

`kmN` keeps a window of N faces around the middle of the value-sorted array, starting at index
⌊(len − N)/2⌋. When the window cannot be centered exactly, it shifts to the **lower** side.

Counts **clamp** rather than error: `2d20kh3` on two dice keeps both, while `2d6dh3` drops both;
read the count as "up to N". A filter with no survivors yields the empty array (then `s` → 0,
`c` → 0).

**Rank selection is stable.** Faces with equal values keep their array order, and among ties the
face **earlier in the array is selected first**: kept first by `kh`/`kl`/`km`, dropped first by
`dh`/`dl`, rerolled first by `rl`/`rh` ([Operators](#operators-clamp-explosion-reroll)). This
matters because faces carry identity: `(1d6{'a'} + 1d6{'b'})kh1` on a tie keeps *a*,
deterministically.

The letter scheme is uniform across [Operators](#operators-clamp-explosion-reroll) and
[Filters](#filters-keeping-and-dropping): **`k`/`d`/`r`** = keep, drop, or reroll, **`h`/`l`** = by
rank (high/low), **`o`/`u`** = by value (over/under), and **`m`** = middle. The same `o` names the
explosion trigger ([Operators](#operators-clamp-explosion-reroll)).

## Final operators: reducing the array

A block or group may carry **at most one** final operator. The default, applied when none is
written, is `s`.

| Glyph | Output |
|---|---|
| `s` | **sum** of the face values (the default) |
| `c` | **count**: how many items (faces) are in the array |
| `i` | **individual**: the list of face values (labels for string faces) |

`s`, `c`, and `i` are uniform reductions over the same array, with **no exceptions**: `s` adds the
item values, `c` counts the items, and `i` lists them. Every face is one item, whether it is a
rolled die, a constant, or a sealed subtotal. Both `((2d6)s + 2d8)c` and
`(4d6kh + 2d8)c` are 3.

Whatever the final operator, the reported **total** is a number: `s` and `i` report the sum of the
face values, `c` reports the count, and a scale (below) multiplies or divides that number. `i`
changes what is *displayed* (the individual faces), never the arithmetic, and it is legal only as
the formula's **outermost** reduction ([Combining blocks](#combining-blocks-constants-and-groups)).

`6d6` and `6d6s` are identical. `6d6ko6c` keeps the sixes and reports how many there are.
`2d6i` reports e.g. `2, 5`; `1d['cat','dog']i` reports `cat` or `dog`.

### Scale

`s` and `c` accept an optional **scale**: `xN` multiplies the reduction by N, `/N` divides it
by N and rounds down, `/Nu` divides it by N and rounds up. The scale is part of the reducer,
so the notation always names what it scales: a sum or a count.

| Form | Reads as |
|---|---|
| `(2d8+3)sx2` | twice the modified total |
| `2d8sx2 + 3` | twice the dice, plus 3 |
| `(2d8+3)s/2` | half the modified total, rounded down |
| `(6d6ko6)c/2u` | half the successes, rounded up |

- **Rounding is floor and ceiling**, never rounding toward zero: `/2` takes −7 to −4, and `/2u`
  takes −7 to −3. The division happens once, at the reduction, so every reported value stays an
  integer.
- N is a **count** from 1 to 1000 ([Limits and safety](#limits-and-safety)). `x1` and `/1` are legal
  and change nothing. The `u` suffix belongs to division only.
- A scale requires its reducer. `2d6x2` is a syntax error because it does not say what is
  multiplied; write `2d6sx2` or `2d6cx2`. To scale a formula of several operands, wrap it:
  `(2d8+3)sx2`. `i` is a report and takes no scale.
- The scale applies to the **reduction**, never to the dice. `1d8sx2` yields only even numbers; a 5e
  critical hit rolls the dice twice and is written `2d8+3`.

## Combining blocks, constants, and groups

- `+` **concatenates** the operand arrays. `-` concatenates the next operand with **every face's
  sign flipped**. `2d8 - 2d4` means `2d8 + −(2d4)`; a leading `-` negates the first operand; signs
  **compose** under nesting, so `-(2d6 - 1d4)` subtracts the d6s and adds the d4 back. A sign
  multiplies the raw roll into the face's value but never touches the raw roll itself. Operators
  keep working on what the die shows ([Operators](#operators-clamp-explosion-reroll)).
- A **constant** is a bare number: a single face in the array. Like any face it is summed by `s`,
  counted by `c`, and printed by `i`; it carries no die identity. Modifiers need no separate rule:
  `2d6+3`, `10 - 2d6`, and `4d8 + 1 + 2d6` all use constants. Zero is legal (`2d6+0`, for example)
  and still weighs one item in a count; the ≥ 1 rule ([Order and errors](#order-and-errors)) is for
  *counts*, never constants.
- `+`/`-` bind **looser than a block's own operators and filters.** Each operand is resolved to its
  array first; then the arrays are joined. So `2d8 - 2d4kh1` rolls 2d4, keeps the best, and
  subtracts *that*. The sign is set at the join, after the operand's own operators and filters have
  run. After a join, group-level operators still read raw rolls
  ([Operators](#operators-clamp-explosion-reroll)) and group-level filters read the signed values
  ([Filters](#filters-keeping-and-dropping)).
- A **group** `(…)` turns an expression into one array so an operator, filter, or final operator can
  apply across its members: `(3d8 + 2d12)kh1`, `(1d20 + 1d6)!`, `(2d20 + 3d6)kh1 + 3d8`.

### Open vs sealed operands

An operand **without** a final operator is **open**: its faces flow directly into the enclosing
array, keeping their individual value, name, and color. An operand **with** an explicit `s`/`c` is
**sealed**: it collapses to a single scalar face before it is joined. This leaves **one item where
there were many**, which is exactly what `c` and `i` then see. A scale
([Final operators](#final-operators-reducing-the-array)) is applied as the seal collapses, so
`(2d6)sx2` seals to one face worth twice the pair's sum.

- `2d6 + 2d8` → four open faces → the top-level sum sees all four (and `i` would list four).
- `(2d6)s + 2d8` → the first block is sealed to one face (its sum) → three faces join.

Both give the same total under `s`; they differ only for `c`, `i`, and subtotals. Sealing is
also how "compare the *totals*" is spelled: `((2d6)s + (2d8)s)kh1` rolls both pairs and keeps
the better pair's sum, where the open `(2d6 + 2d8)kh1` keeps the best single die of four.

A sealed face has **no source**, so no operator can touch it
([Operators](#operators-clamp-explosion-reroll)), but it keeps a **unanimous appearance**. If every
summarized face that has a name (or color) agrees on it, the sealed face carries it. Faces without
an appearance, such as constants, do not veto the result. If named or colored faces disagree, the
sealed face carries no appearance. So `(2d6{'fire'}+3)s` still feeds the *fire* subtotal, while
`(2d6{'fire'} + 2d8{'cold'})s` seals to a plain face. A sealed empty array is a face valued 0 and
still counts as one item under `c`.

`i` is a terminal report and may only stand as the formula's outermost reduction. If nested
anywhere, it is an error: `2d6i + 3` and `((2d6)i)c` are both invalid. The top-level formula is
an implicit group summed by default; to report the whole thing with `c` or `i`, wrap it:
`(6d6ko6)c`. The same wrap scales a whole formula: `(2d8+3)sx2`. A reducer on the whole
formula keeps its faces open for display, and the total carries the scale; the result reports
the outermost scale next to the total so a renderer can show it.

## Order and errors

- **Operators precede filters precede the final operator**, in that order, within any block or
  group. Out-of-order is a **syntax error**, not a silent reorder: `6d6kh3!` is invalid; write
  `(6d6kh3)!`. Likewise a final operator before a filter (`6d6skh1`) is invalid.
- Within a class, evaluation is **strictly left-to-right**: `6d6!kh3kl1` explodes, keeps the
  highest 3, then keeps the lowest 1 (the smallest of the top three); `6d6ru2*` rerolls twos then
  explodes, while `6d6*ru2` explodes then rerolls.
- A block may carry **only one** final operator and **at most one explosion operator**; a face
  list may not have a trailing comma; a color and a name may each appear at most once in an
  appearance.
- A reducer takes **at most one scale**, and a scale never stands alone: `2d6x2`, `2d6sx2x3`,
  and a scale on `i` (`2d6ix2`) are syntax errors.
- **Every count is at least 1**: `0d6`, `kh0`, and `rl0` are rejected. Thresholds are *values*
  and may be any integer, including zero and negatives (`4dFko0`).
- A threshold consumes a following minus sign **greedily**: `2d6ko-1` and, because whitespace is
  insignificant, `2d6 ko - 1` both mean `ko(−1)`, never a subtraction.

## Limits and safety

These bound the payload and stop pathological formulas. The numbers are fixed implementation
limits, not per-formula choices, so a formula that rolls in one place rolls everywhere. They are
exported frozen as `LIMITS`, for an application that wants to show a character counter or a "too
many dice" hint without repeating the numbers:

```ts
import { LIMITS } from "rollatom";

LIMITS.draws; // 100    LIMITS.operands; // 20
LIMITS.chain; // 50     LIMITS.faces;    // 100
LIMITS.length; // 200   LIMITS.value;    // 1000
```

- **Total dice rolled** across a formula ≤ 100, **counting every draw**, including base dice,
  explosion rolls, and rerolls alike. Exceeding it is an error, not a truncation. The **base**
  dice are counted **at parse time**, formula-wide, so `60d6 + 60d6` is rejected before any
  roll and `validateDice` catches it; operator draws are counted as they happen.
- **Unbounded explosions** (`!`, `*`) and **until-rerolls** (`rru`, `rro`) cap at 50 chained
  rolls per face; hitting the cap is an error. Impossible and certain triggers are rejected
  **at parse time**, before any roll: a trigger no face can meet (`d6!o7`, `d6rru0`) is dead,
  and an unbounded glyph on a die whose *every* face meets the trigger (`d[3,3]!`, `d6!o1`,
  `d6rru6`) can never halt. A certainty that only arises at runtime (for example, a `min` that
  lifts every face to the trigger) still stops at the chain cap. The bounded glyphs are always
  finite, so `d6!!o1` is legal, as are dead bounds on the single-shot rerolls (`ru0`).
- **Face value magnitude** for literal faces, `=INT` assignments, constants, clamp bounds,
  and scale factors is capped at ±1000; a face list holds **2–100 faces**.
- **Formula length** ≤ 200 characters, measured after whitespace is stripped; **operands** per
  expression ≤ 20.

### Determinism

For a given formula and RNG, the draw sequence is fixed, making rolls replayable and auditable:

1. **Base rolls first, formula-wide**: every block left-to-right, each block's dice
   left-to-right, one draw per die.
2. **Then operator tokens in text order**, one pass each over their current array in array
   order. Unbounded explosion glyphs and until-rerolls resolve one face's whole chain before
   moving to the next face; clamps draw nothing.
3. Filters and final operators draw nothing.
4. `+`/`-` concatenate already-resolved operand arrays left-to-right.

## Worked examples

| Formula | Reads as |
|---|---|
| `2d6+3` | sum of two d6, plus 3 |
| `2d8 - 2d4` | sum of 2d8 minus sum of 2d4 |
| `2d8 - 2d4kh1` | 2d8 minus the *better* of two d4 |
| `-3d6` | the negated sum of three d6 |
| `10 - 2d6` | 10 minus the sum of two d6 |
| `4dF` | four Fate dice, summed (−4…+4) |
| `2d20kh1` | advantage: keep the higher d20 |
| `2d100kl1` | roll-under advantage: keep the lower d100 |
| `6d6ko6c` | roll 6d6, keep the sixes, count them (a success pool) |
| `6d6ko6` | the same, but *sum* the sixes (why `c` matters) |
| `4d6rl1` | roll 4d6, reroll the single lowest once |
| `4d6ru2` | roll 4d6, reroll each die showing 2 or less |
| `4d6rru2` | roll 4d6, reroll 1s and 2s **until none remain** |
| `4d6min3` | four d6 that read no lower than 3; sugar for `4d[3,3,3,4,5,6]` |
| `d[3..6]` | a uniform 3-to-6 die (the terminal distribution of `rru2` on a d6) |
| `d[10..60:10] + d6` | d66: a tens die and a units die |
| `6d6!c` | explode 6d6 without bound, count every die (spawns included) |
| `6d6!dl2` | exploding pool, then drop the two lowest of whatever grew |
| `3d10!o9ko8c` | World of Darkness 9-again: explode on 9+, count the 8+ successes |
| `10d[-1,0x6,1x3]` | net successes on d10s: 8+ counts one, 1s subtract one |
| `2d6*kh1` | vertical: keep the biggest exploded *total* |
| `2d6!kh1` | horizontal: keep the biggest single *face* |
| `((2d6)s + (2d8)s)kh1` | roll both pairs, keep the better pair's *total* |
| `(2d8+3)s/2` | resistance: half the modified total, rounded down |
| `(2d8+3)sx2` | vulnerability: twice the modified total |
| `2d8sx2 + 3` | twice the dice, plus the flat bonus |
| `(6d6ko6)c/2u` | half the successes, rounded up |
| `1d['cat','dog']i` | show `cat` or `dog` |
| `2d['crit'=20,'hit'=10,'miss'=0]s` | two custom dice, summed by value |
| `(2d20 + 3d6)kh1 + 3d8` | keep the single best of five dice, add 3d8 |
| `(1d20 + 1d6)!kh1` | explode the pair, then keep the highest |
| `4d6{#red,'fire'}` | four red dice named *fire*, contributing a *fire* subtotal |

## Installing without npm

The published package is one ES module that imports nothing, so it also runs straight from a URL
or from a copy inside your own tree. Every route below loads the same file.

**From a CDN.** Any npm-backed CDN serves the built module. Pin the version, so a later release
cannot change what the page loads:

```html
<script type="module">
  import { rollDice } from "https://esm.sh/rollatom@0.1.0";

  console.log(rollDice("2d20kh1 + 5").total);
</script>
```

`https://cdn.jsdelivr.net/npm/rollatom@0.1.0/dist/index.js` and
`https://unpkg.com/rollatom@0.1.0/dist/index.js` serve the same module.

**Through an import map**, when application code should keep writing the bare name:

```html
<script type="importmap">
  { "imports": { "rollatom": "https://esm.sh/rollatom@0.1.0" } }
</script>
<script type="module">
  import { rollDice } from "rollatom";
</script>
```

**Vendored.** `dist/index.js` is a single file with no imports, so dropping it into a project
leaves nothing to resolve; keep `dist/index.d.ts` beside it for types. A TypeScript project can
copy `src/index.ts` instead and compile it with everything else, which is also the way to build
the library without installing anything: the file needs no plugins and no build step of its own.

**In Deno**, `npm:rollatom@0.1.0` and the esm.sh URL both resolve:

```ts
import { rollDice } from "npm:rollatom@0.1.0";
```

Whatever the route, the runtime must provide `crypto.getRandomValues`, or a `random` function has
to be supplied per call (see [Configuration](#configuration)). Nothing else is required.

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
is deterministic for a given formula, as specified in [Limits and safety](#limits-and-safety).

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
the same name ([Appearance](#appearance)). `autoColor` applies only to a named subtotal with no
explicit color; it does not assign a color to the individual faces. The default `autoColor` returns
the same color for the same label.

`RollOptions` currently contains only `random`, `palette`, and `autoColor`. Grammar limits and
safety caps are not per-call options; they are fixed, described in
[Limits and safety](#limits-and-safety), and readable through the frozen `LIMITS` export.

## Validating without rolling

`validateDice` runs the parse phase and draws no dice. It returns the `DiceError` the same input
would throw, or `null`. Use it for an input field that should reject a bad formula as it is
typed, or to check macros before storing them:

```ts
import { validateDice } from "rollatom";

validateDice("2d20kh1 + 5");  // null
validateDice("6d6kh3!");      // DiceError: operators may not follow filters
validateDice("d6!o7");        // DiceError: an explosion that can never trigger
validateDice("60d6 + 60d6");  // DiceError: more base dice than the draw cap allows
```

It applies every static check `rollDice` makes: syntax, formula length, operand count, `i` placement
([Combining blocks](#combining-blocks-constants-and-groups)), impossible and never-halting triggers
([Limits and safety](#limits-and-safety)), and the total base dice a formula is certain to roll.
Only `palette` is read from the options, because `#name` tokens must resolve against the palette the
roll will use; passing the roll's own `RollOptions` object is fine.

Two limits depend on the dice rather than the text, so a validated formula can still fail at roll
time: the total-draw cap once explosions and rerolls have drawn, and the 50-roll chain cap on a
single face ([Limits and safety](#limits-and-safety)). Calling `validateDice` first does not remove
the need to handle `DiceError` from `rollDice`.
