import { describe, expect, it } from "vitest";
import { DiceError, LIMITS, rollDice, validateDice } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Executable specification for the universal dice grammar (see `docs/GRAMMAR.md`),
// implemented by the RollAtom engine in `src/index.ts`.
//
// ── RNG contract the implementation must honor ───────────────────────────────
// `random(faceCount)` returns a 1-based *face index* in [1, faceCount]. A die
// with faces `[a, b, c]` and a returned index `2` rolled `b`. For `dN` the index
// equals the value; for `dF` indices 1/2/3 map to −1/0/+1.
//
// RNG is consumed in a fixed order so tests are deterministic (spec: Limits and safety):
//   1. Base roll - every block left-to-right, each block's dice left-to-right,
//      one draw per die.
//   2. Operator passes - each operator token left-to-right makes one pass over
//      the current array (array order), drawing as it triggers rolls. Unbounded
//      explosion glyphs (`!`, `*`) and until-rerolls (`rru`, `rro`) resolve one
//      face's whole chain before the next face; clamps draw nothing.
//   3. Filters and final operators draw nothing.
//   4. `+`/`-` combine already-resolved operand arrays; operands resolve L→R.
//
// ── Result contract asserted below ───────────────────────────────────────────
//   total      : number  - `s` and `i` → sum of face values; `c` → face count
//   values     : number[] - final-array face values (signed), in order (incl. constants)
//   labels?    : string[] - per-face labels; present for string faces and `i`
//   subtotals? : { label, total, color? }[] - sum grouped by name (see Appearance)
//   faces      : NotationFace[] - every rolled face in order, filter-dropped ones marked
//                `dropped` and excluded from all of the above (display-only survivors rule)
// ─────────────────────────────────────────────────────────────────────────────

interface Spec {
  total: number;
  values: number[];
  labels?: string[];
  subtotals?: { label: string; total: number; color?: string }[];
}

// A deterministic RNG returning the given 1-based indices in order. Throws on
// over-draw so a test also pins *how many* dice the formula rolls.
const seq = (...indices: number[]) => {
  let i = 0;
  return (faceCount: number) => {
    if (i >= indices.length) throw new Error(`RNG over-drawn after ${indices.length} rolls`);
    const idx = indices[i++];
    if (idx < 1 || idx > faceCount) throw new Error(`face index ${idx} out of range 1..${faceCount}`);
    return idx;
  };
};

// Always rolls the maximum face, forcing explosions to reach their cap.
const maxFace = (faceCount: number) => faceCount;

const roll = (input: string, rng: (n: number) => number = () => 1) =>
  rollDice(input, { random: rng }) as unknown as Spec;

describe("dice notation grammar", () => {
  // ── Blocks and faces ───────────────────────────────────────────────────────
  describe("blocks and faces", () => {
    it("rolls a single die (d6 == 1d6)", () => {
      expect(roll("d6", seq(4)).total).toBe(4);
    });

    it("rolls and sums a pool (NdF is infix)", () => {
      expect(roll("4d8", seq(3, 8, 1, 5)).total).toBe(17);
    });

    it("treats dN as sugar for 1..N", () => {
      expect(roll("d6", seq(6)).total).toBe(6);
      expect(() => roll("d1")).toThrow(DiceError); // fewer than 2 faces
    });

    it("rolls Fate dice as sugar for [-1, 0, +1]", () => {
      // indices 1/2/3 → −1/0/+1
      expect(roll("4dF", seq(1, 2, 3, 3)).total).toBe(1);
      expect(roll("dF", seq(1)).total).toBe(-1);
    });

    it("rolls numeric custom faces at their literal value", () => {
      expect(roll("d[10,20]", seq(2)).total).toBe(20);
      expect(roll("d[-1,0,1]", seq(1)).total).toBe(-1);
    });

    it("values string faces by 1-based position by default", () => {
      const cat = roll("d['cat','dog']", seq(1));
      expect(cat.total).toBe(1);
      expect(cat.labels).toEqual(["cat"]);
      expect(roll("d['cat','dog']", seq(2)).total).toBe(2); // dog → 2
    });

    it("honors explicit face-value assignment, positional otherwise", () => {
      expect(roll("d['cat'=-12,'dog']", seq(1)).total).toBe(-12);
      expect(roll("d['cat'=-12,'dog']", seq(2)).total).toBe(2); // dog keeps position 2
    });

    it("allows repeated face values", () => {
      expect(roll("d['heads'=1,'tails'=1]", seq(2)).total).toBe(1);
    });

    it("expands a range to its faces (d[1..6] == d6)", () => {
      expect(roll("d[1..6]", seq(6)).total).toBe(6);
      expect(roll("d[3..6]", seq(1)).total).toBe(3); // uniform on 3..6, unlike min3
      expect(roll("d[-1..1]", seq(1)).total).toBe(-1);
    });

    it("expands a stepped range, including only values up to the end", () => {
      expect(roll("d[10..60:10]", seq(4)).total).toBe(40); // the d66 tens die
      expect(roll("d[1..10:3]", seq(4)).total).toBe(10); // {1,4,7,10}: the end lands exactly
      expect(roll("d[1..9:3]", seq(3)).total).toBe(7); // {1,4,7}: 9 is out of step
      expect(() => roll("d[1..9:3]", seq(4))).toThrow(); // ...and the die has only 3 faces
    });

    it("repeats a face with `x` - weighted faces without the typing", () => {
      // Positions: 1 → −1, 2..7 → 0, 8..10 → 1; same die as the written-out list.
      expect(roll("d[-1,0x6,1x3]", seq(8)).total).toBe(1);
      expect(roll("d[-1,0x6,1x3]", seq(1)).total).toBe(-1);
      expect(roll("d[1..3,5]", seq(4)).total).toBe(5); // ranges and literals mix
    });

    it("gives repeated string faces expanded positional values (use `=` to share one)", () => {
      // Literal desugar: 'blank' occupies positions 1..4, 'hit' positions 5..6.
      const hit = roll("d['blank'x4,'hit'x2]", seq(5));
      expect(hit.total).toBe(5);
      expect(hit.labels).toEqual(["hit"]);
      expect(roll("d['miss'=0x4,'hit'=1 x2]", seq(5)).total).toBe(1); // explicit value shared
    });

    it("rejects a descending range, a zero step, and repetition on a range", () => {
      expect(() => roll("d[4..1]")).toThrow(DiceError);
      expect(() => roll("d[1..6:0]")).toThrow(DiceError);
      expect(() => roll("d[1..3x2]")).toThrow(DiceError);
      expect(() => roll("d[1x0,2]")).toThrow(DiceError); // counts are ≥ 1 (see Order and errors)
    });

    it("holds the expanded list to the same caps as a written-out one", () => {
      expect(() => roll("d[1..101]")).toThrow(DiceError); // more than 100 faces
      expect(() => roll("d[0..2000]")).toThrow(DiceError); // face value beyond ±1000
      expect(() => roll("d[1x101]")).toThrow(DiceError);
    });

    it("rejects empty and one-face lists and a trailing comma", () => {
      expect(() => roll("d[]")).toThrow(DiceError);
      expect(() => roll("d[5]")).toThrow(DiceError); // one-face dice are invalid
      expect(() => roll("d[1,2,]")).toThrow(DiceError);
    });
  });

  // ── Appearance ─────────────────────────────────────────────────────────────
  describe("appearance", () => {
    it("accepts a color, a name, or both in either order", () => {
      expect(roll("2d6{#red}", seq(2, 5)).total).toBe(7);
      expect(roll("2d6{'necrotic'}", seq(2, 5)).total).toBe(7);
      expect(roll("2d6{#red,'necrotic'}", seq(2, 5)).total).toBe(7);
      expect(roll("2d6{'necrotic',#red}", seq(2, 5)).total).toBe(7);
    });

    it("accepts hex colors", () => {
      expect(roll("2d6{#f0f}", seq(1, 1)).total).toBe(2);
      expect(roll("2d6{#ff00aa}", seq(1, 1)).total).toBe(2);
    });

    it("distinguishes a color word from a die named after it", () => {
      // #red is the color; 'red' is a die named red. Both are legal.
      expect(roll("d6{#red}", seq(3)).total).toBe(3);
      expect(roll("d6{'red'}", seq(3)).labels).toEqual(["red"]);
    });

    it("reports subtotals grouped by name", () => {
      const result = roll("2d6{'fire'} + 1d4{'cold'}", seq(2, 5, 3));
      expect(result.total).toBe(10);
      expect(result.subtotals).toEqual([
        expect.objectContaining({ label: "fire", total: 7 }),
        expect.objectContaining({ label: "cold", total: 3 }),
      ]);
    });

    it("does not create a subtotal for a color without a name", () => {
      expect(roll("2d6{#red}", seq(2, 5)).subtotals).toBeUndefined();
    });

    it("rejects two colors or two names", () => {
      expect(() => roll("2d6{#red,#blue}")).toThrow(DiceError);
      expect(() => roll("2d6{'a','b'}")).toThrow(DiceError);
    });

    it("rejects appearance on a group or a constant", () => {
      expect(() => roll("(2d6+d8){#red}")).toThrow(DiceError);
      expect(() => roll("3{#red}")).toThrow(DiceError);
    });

    // Within-roll association: a name's explicit color paints every colorless
    // same-named die and the name's subtotal, wherever in the formula it appears.
    it("paints colorless same-named dice with the name's explicit color", () => {
      const result = rollDice("1d6{'fire',#red} + 1d8{'fire'}", { random: seq(3, 5) });
      expect(result.faces.map((f) => f.color)).toEqual(["#cc3333", "#cc3333"]);
      expect(result.subtotals).toEqual([{ label: "fire", total: 8, color: "#cc3333" }]);
    });

    it("applies a color even when it follows an earlier die with the same name", () => {
      const result = rollDice("1d8{'fire'} + 1d6{'fire',#red}", { random: seq(5, 3) });
      expect(result.faces.map((f) => f.color)).toEqual(["#cc3333", "#cc3333"]);
      expect(result.subtotals).toEqual([{ label: "fire", total: 8, color: "#cc3333" }]);
    });

    it("reaches into groups and keeps conflicting explicit colors as written", () => {
      // The first explicit color determines the name's subtotal color. A die keeps its own
      // explicit color.
      const result = rollDice("(1d6{'fire',#red} + 1d8{'fire',#blue}) + 1d4{'fire'}", { random: seq(3, 5, 2) });
      expect(result.faces.map((f) => f.color)).toEqual(["#cc3333", "#3366cc", "#cc3333"]);
      expect(result.subtotals).toEqual([{ label: "fire", total: 10, color: "#cc3333" }]);
    });

    it("never crosses names, and a bare color paints only its own block", () => {
      const result = rollDice("1d6{'fire',#red} + 1d8{'cold'} + 1d4{#blue}", { random: seq(3, 5, 2) });
      expect(result.faces.map((f) => f.color)).toEqual(["#cc3333", undefined, "#3366cc"]);
      expect(result.subtotals?.map((s) => s.label)).toEqual(["fire", "cold"]);
      expect(result.subtotals?.[1].color).not.toBe("#cc3333");
    });
  });

  // ── Operators: clamp ───────────────────────────────────────────────────────
  describe("clamp", () => {
    it("min raises low faces, max lowers high ones", () => {
      expect(roll("4d6min3", seq(1, 2, 3, 4)).total).toBe(13); // [3,3,3,4]
      expect(roll("4d6max3", seq(1, 2, 3, 4)).total).toBe(9); // [1,2,3,3]
    });

    it("runs left-to-right against an explosion", () => {
      // Clamped first: no face can show the trigger - nothing explodes, no spawn draw.
      expect(roll("2d6max5!", seq(6, 3)).total).toBe(8); // [5,3]
      // Exploded first: the chain resolves, then the clamp flattens it.
      expect(roll("2d6!max5", seq(6, 3, 4)).total).toBe(12); // [6,3,4] → [5,3,4]
    });

    it("clamps into negative values (Fate)", () => {
      expect(roll("4dFmin0", seq(1, 1, 2, 3)).total).toBe(1); // [-1,-1,0,1] → [0,0,0,1]
    });
  });

  // ── Operators: explosion ───────────────────────────────────────────────────
  describe("explosion", () => {
    it("`!` explodes horizontally without bound - spawns keep exploding", () => {
      // base [6,3]; die1 chain: spawn 6 (trigger, continue) → spawn 2 (stop).
      const result = roll("2d6!", seq(6, 3, 6, 2));
      expect(result.total).toBe(17);
      expect(result.values).toHaveLength(4);
    });

    it("`!!` explodes horizontally, one layer - the spawn is inert", () => {
      // base [6,3]; die1 spawns a 6, which does NOT re-explode.
      const result = roll("2d6!!", seq(6, 3, 6));
      expect(result.total).toBe(15);
      expect(result.values).toHaveLength(3);
    });

    it("`*` explodes vertically without bound - the seat keeps summing", () => {
      // base [6,3]; die1 seat = 6 + 6 + 2 = 14; array length unchanged.
      const result = roll("2d6*", seq(6, 3, 6, 2));
      expect(result.total).toBe(17);
      expect(result.values).toHaveLength(2);
    });

    it("`**` explodes vertically, one extra roll", () => {
      // base [6,3]; die1 seat = 6 + 6 = 12; the second 6 does not continue the chain.
      const result = roll("2d6**", seq(6, 3, 6));
      expect(result.total).toBe(15);
      expect(result.values).toHaveLength(2);
    });

    it("horizontal grows the count, vertical does not", () => {
      expect(roll("2d6!c", seq(6, 3, 4)).total).toBe(3); // 2 originals + 1 spawn
      expect(roll("2d6*c", seq(6, 3, 4)).total).toBe(2); // still two dice
    });

    it("the vertical/horizontal split changes what a rank filter keeps", () => {
      // The same rolls and filter produce different winners by design.
      expect(roll("2d6*kh1", seq(6, 3, 6, 2)).total).toBe(14); // biggest exploded total
      expect(roll("2d6!kh1", seq(6, 3, 6, 2)).total).toBe(6); //  biggest single face
    });

    it("`oN` moves the trigger to N-or-more (9-again)", () => {
      // d10s explode on 9+: die1 chains 9 → 10 → 1; die2 (3) never triggers.
      const result = roll("2d10!o9", seq(9, 3, 10, 1));
      expect(result.total).toBe(23);
      expect(result.values).toHaveLength(4);
      expect(roll("2d10!!o9", seq(9, 3, 10)).total).toBe(22); // one layer: the 10 is inert
    });

    it("explodes on the maximum value of a custom die", () => {
      // faces [1,6,6]: max value is 6 (index 2 or 3). Rolling it explodes.
      expect(roll("d[1,6,6]*", seq(2, 1)).total).toBe(7); // 6 + 1
    });

    it("allows at most one explosion operator per block", () => {
      expect(() => roll("2d6!*")).toThrow(DiceError);
      expect(() => roll("2d6!!!")).toThrow(DiceError); // greedy lexing: `!!` then `!`
    });

    it("skips faces without a source", () => {
      // The constant 3 cannot explode; the d6 chain runs normally.
      const result = roll("(2d6+3)!", seq(6, 3, 2));
      expect(result.total).toBe(14);
      expect(result.values).toHaveLength(4);
    });

    it("spawns inherit the exploding face's sign", () => {
      // (1d6 - 1d6)!: both raw 6s trigger; each spawn keeps its parent's sign.
      const result = roll("(1d6 - 1d6)!", seq(6, 6, 2, 3));
      expect(result.total).toBe(-1); // 6 − 6 + 2 − 3
      expect(result.values).toHaveLength(4);
    });

    it("rejects impossible triggers, and certain triggers on unbounded glyphs", () => {
      expect(() => roll("d6!o7")).toThrow(DiceError); // no face can meet it
      expect(() => roll("d6!o1")).toThrow(DiceError); // every face meets it - never halts
      expect(() => roll("d[3,3]!")).toThrow(DiceError); // every face is the maximum
      expect(roll("d6!!o1", seq(2, 5)).total).toBe(7); // bounded + certain is finite
    });
  });

  // ── Operators: reroll ──────────────────────────────────────────────────────
  describe("reroll", () => {
    it("`ruN` rerolls dice valued N or less, once, in place", () => {
      const result = roll("4d6ru2", seq(1, 2, 6, 3, 4, 5)); // reroll die1(1)→4, die2(2)→5
      expect(result.total).toBe(18);
      expect(result.values).toHaveLength(4);
    });

    it("`roN` rerolls dice valued N or more, once", () => {
      expect(roll("4d6ro5", seq(6, 5, 1, 2, 3, 3)).total).toBe(9); // 6,5 → 3,3
    });

    it("`rlN` rerolls the N lowest dice, once", () => {
      expect(roll("4d6rl1", seq(5, 2, 6, 3, 4)).total).toBe(18); // lowest (2) → 4
    });

    it("`rhN` rerolls the N highest dice, once", () => {
      expect(roll("4d6rh1", seq(6, 2, 3, 1, 4)).total).toBe(10); // highest (6) → 4
    });

    it("keeps the rerolled value even if it still qualifies", () => {
      // die valued 1 rerolls once to another 1; no second reroll.
      expect(roll("d6ru2", seq(1, 1)).total).toBe(1);
    });

    it("selects the earlier face among ties", () => {
      // Two 2s tie for lowest; the FIRST one rerolls → [3,2,5,6].
      expect(roll("4d6rl1", seq(2, 2, 5, 6, 3)).total).toBe(16);
    });

    it("replaces a vertical seat with one fresh roll", () => {
      // die1 seat = 6 + 2 = 8; ro5 selects it (8 ≥ 5) and replaces the WHOLE seat with 3.
      expect(roll("2d6**ro5", seq(6, 1, 2, 3)).total).toBe(4);
    });

    it("skips faces without a source", () => {
      // The lowest face is the constant 1, which rerolls ignore; the d6 rerolls instead.
      expect(roll("(1d6+1)rl1", seq(3, 5)).total).toBe(6);
    });

    it("selects by raw roll and keeps the join's sign", () => {
      // The d4s' raw 2 and 1 qualify (their values are −2, −1); fresh rolls still subtract.
      const result = roll("(2d8 - 2d4)ru2", seq(5, 7, 2, 1, 3, 4));
      expect(result.total).toBe(5); // 5 + 7 − 3 − 4
      expect(result.values).toEqual([5, 7, -3, -4]);
    });

    it("never selects a negated face by its signed value", () => {
      // ru0 compares raw rolls, and a raw roll is never 0 or less - a no-op, no extra draw.
      expect(roll("(-d6)ru0", seq(4)).total).toBe(-4);
    });

    it("`rruN` rerolls dice valued N or less until they no longer qualify", () => {
      // die1 chains 1 → 2 → 5 (whole chain before the next face); die2 (4) never qualifies.
      const result = roll("2d6rru2", seq(1, 4, 2, 5));
      expect(result.total).toBe(9);
      expect(result.values).toEqual([5, 4]);
    });

    it("`rroN` rerolls dice valued N or more until under the threshold", () => {
      expect(roll("d10rro9", seq(10, 9, 3)).total).toBe(3);
    });

    it("is distribution-equivalent to the restricted die - reroll 1s until gone", () => {
      // 1d10rru1 ends exactly like d[2..10]; the die keeps its d10 identity.
      const result = rollDice("1d10rru1", { random: seq(1, 1, 7) });
      expect(result.total).toBe(7);
      expect(result.faces[0].faces).toBe(10);
    });

    it("records the discarded rolls on the face, single rerolls included", () => {
      const until = rollDice("d6rru2", { random: seq(1, 2, 5) });
      expect(until.faces[0].rerolls).toEqual([1, 2]);
      expect(until.faces[0].history).toEqual([5]);
      const once = rollDice("d6ru2", { random: seq(1, 4) });
      expect(once.faces[0].rerolls).toEqual([1]);
    });

    it("rejects dead and certain until-thresholds, like unbounded explosions", () => {
      expect(() => roll("d6rru0")).toThrow(DiceError); // no face qualifies - dead
      expect(() => roll("d6rru6")).toThrow(DiceError); // every face qualifies - never halts
      expect(() => roll("d6rro7")).toThrow(DiceError);
      expect(() => roll("d6rro1")).toThrow(DiceError);
      expect(roll("d6ru0", seq(4)).total).toBe(4); // the single-shot form still allows dead bounds
    });
  });

  // ── Filters ────────────────────────────────────────────────────────────────
  describe("filters", () => {
    it("keeps the highest / lowest by rank (default 1)", () => {
      expect(roll("2d20kh1", seq(4, 17)).total).toBe(17);
      expect(roll("2d20kl1", seq(4, 17)).total).toBe(4);
      expect(roll("4d6kh2", seq(1, 6, 3, 5)).total).toBe(11); // 6 + 5
    });

    it("keeps the middle by rank, shifting to the lower side off-centre", () => {
      expect(roll("5d6km", seq(5, 1, 3, 2, 4)).total).toBe(3); // median of 1..5
      expect(roll("4d6km", seq(4, 1, 3, 2)).total).toBe(2); // lower of the middle pair
      expect(roll("4d6km2", seq(4, 1, 3, 2)).total).toBe(5); // the middle pair, summed
    });

    it("drops the highest / lowest by rank (default 1)", () => {
      expect(roll("4d6dl1", seq(4, 1, 3, 2)).total).toBe(9); // drop the 1
      expect(roll("4d6dh2", seq(4, 1, 3, 2)).total).toBe(3); // drop 4 and 3
    });

    it("keeps by value threshold: over and under", () => {
      expect(roll("6d6ko6", seq(6, 3, 6, 1, 6, 5)).total).toBe(18); // sum of the sixes
      expect(roll("4d6ku2", seq(1, 2, 3, 4)).total).toBe(3); // 1 + 2
    });

    it("drops by value threshold", () => {
      expect(roll("4d6do3", seq(4, 1, 3, 2)).total).toBe(3); // drop ≥3 → 1 + 2
      expect(roll("4d6du2", seq(4, 1, 3, 2)).total).toBe(7); // drop ≤2 → 4 + 3
    });

    it("clamps a rank count instead of erroring (keep - or drop - up to N)", () => {
      expect(roll("2d20kh3", seq(4, 17)).total).toBe(21); // keeps both
      expect(roll("2d6dh3", seq(2, 5)).total).toBe(0); // drops both - empty is legal
    });

    it("yields an empty array when nothing passes a value filter", () => {
      expect(roll("3d6ko6", seq(1, 2, 3)).total).toBe(0); // sum of nothing
      expect(roll("3d6ko6c", seq(1, 2, 3)).total).toBe(0); // count of nothing
    });

    it("selects the earlier face among ties - appearance rides along", () => {
      const result = roll("(1d6{'a'} + 1d6{'b'})kh1", seq(4, 4));
      expect(result.total).toBe(4);
      expect(result.labels).toEqual(["a"]);
    });

    it("compares signed values after a join", () => {
      // Group-level kh sees contributions: the d4s are negative, so a d8 always wins.
      expect(roll("(2d8 - 2d4)kh1", seq(5, 7, 2, 1)).total).toBe(7);
    });
  });

  // ── Final operators ────────────────────────────────────────────────────────
  describe("final operators", () => {
    it("defaults to sum; `s` is explicit sum", () => {
      expect(roll("6d6", seq(1, 2, 3, 4, 5, 6)).total).toBe(21);
      expect(roll("6d6s", seq(1, 2, 3, 4, 5, 6)).total).toBe(21);
    });

    it("`c` counts the surviving dice", () => {
      expect(roll("6d6ko6c", seq(6, 3, 6, 1, 6, 5)).total).toBe(3);
    });

    it("`i` lists the individual faces (labels for string faces)", () => {
      expect(roll("2d6i", seq(2, 5)).values).toEqual([2, 5]);
      expect(roll("1d['cat','dog']i", seq(1)).labels).toEqual(["cat"]);
    });

    it("`i` reports the sum as its total - display changes, arithmetic doesn't", () => {
      expect(roll("2d6i", seq(2, 5)).total).toBe(7);
    });
  });

  // ── Scale ──────────────────────────────────────────────────────────────────
  describe("scale", () => {
    it("`xN` multiplies a sealed block's reduction before the join", () => {
      expect(roll("2d8sx2 + 3", seq(5, 3)).total).toBe(19); // (5+3)×2, then +3
    });

    it("scales the whole formula when the reducer wraps it, faces staying open", () => {
      const result = roll("(2d8+3)sx2", seq(5, 3));
      expect(result.total).toBe(22); // (5+3+3)×2
      expect(result.values).toEqual([5, 3, 3]); // individual dice still reported
    });

    it("`/N` divides rounding down; `/Nu` rounds up", () => {
      expect(roll("(2d8+3)s/2", seq(5, 3)).total).toBe(5); // 11/2 → 5
      expect(roll("(2d8+3)s/2u", seq(5, 3)).total).toBe(6); // 11/2 → 6
    });

    it("rounds toward minus infinity (floor), never toward zero", () => {
      expect(roll("(2d6 - 10)s/2", seq(1, 2)).total).toBe(-4); // −7/2 → −4
      expect(roll("(2d6 - 10)s/2u", seq(1, 2)).total).toBe(-3); // −7/2 → −3
    });

    it("scales a count", () => {
      expect(roll("(6d6ko6)c/2u", seq(6, 3, 6, 1, 6, 5)).total).toBe(2); // 3 successes → 2
      expect(roll("2d6cx2", seq(2, 5)).total).toBe(4);
    });

    it("a sealed face carries the scaled value into later comparisons", () => {
      // The seal is one face worth 22; kh1 compares it against the d20's 18.
      expect(roll("((2d8+3)sx2 + 1d20)kh1", seq(5, 3, 18)).total).toBe(22);
    });

    it("keeps a unanimous appearance on a scaled seal", () => {
      const result = roll("(2d6{'fire'}+3)sx2 + 1d4", seq(2, 5, 3));
      expect(result.total).toBe(23); // (7+3)×2 + 3
      expect(result.subtotals).toEqual([expect.objectContaining({ label: "fire", total: 20 })]);
    });

    it("reports the outermost scale so a renderer can show it", () => {
      const result = rollDice("(2d8+3)s/2u", { random: seq(5, 3) });
      expect(result.scale).toEqual({ op: "/", by: 2, up: true });
      expect(rollDice("2d6", { random: seq(1, 1) }).scale).toBeUndefined();
    });

    it("requires a reducer: a bare scale is an error", () => {
      expect(() => roll("2d6x2")).toThrow(DiceError);
      expect(() => roll("2d6/2")).toThrow(DiceError);
      expect(() => roll("2d6ix2")).toThrow(DiceError); // i takes no scale
    });

    it("allows at most one scale, and `u` on division only", () => {
      expect(() => roll("2d6sx2x3")).toThrow(DiceError);
      expect(() => roll("2d6s/2x2")).toThrow(DiceError);
      expect(() => roll("2d6sx2u")).toThrow(DiceError);
    });

    it("bounds the factor like a face value and rejects zero", () => {
      expect(() => roll("2d6sx0")).toThrow(DiceError);
      expect(() => roll("2d6sx1001")).toThrow(DiceError);
      expect(roll("2d6sx1", seq(2, 5)).total).toBe(7); // a legal no-op
    });

    it("is whitespace-insensitive like every token sequence", () => {
      expect(roll("(2d6 + 3) s / 2 u", seq(1, 3)).total).toBe(4); // 7/2 rounded up
    });
  });

  // ── Dropped faces (display contract) ───────────────────────────────────────
  // Filters mark faces dropped instead of erasing them, so a renderer can show the
  // whole roll - the advantage die that lost, the pool dice that missed - while the
  // arithmetic surface (`total`, `values`, `labels`, `subtotals`) sees survivors only.
  describe("dropped faces", () => {
    it("keeps a filtered-out face in `faces`, marked, in roll order", () => {
      const result = rollDice("2d20kh1", { random: seq(4, 17) });
      expect(result.total).toBe(17);
      expect(result.values).toEqual([17]);
      expect(result.faces.map((face) => [face.raw, face.dropped ?? false])).toEqual([[4, true], [17, false]]);
    });

    it("marks count-mode misses dropped; the count sees only hits", () => {
      const result = rollDice("6d6ko6c", { random: seq(6, 3, 6, 1, 6, 5) });
      expect(result.total).toBe(3);
      expect(result.values).toEqual([6, 6, 6]);
      expect(result.faces.map((face) => face.dropped ?? false)).toEqual([false, true, false, true, false, true]);
    });

    it("keeps dropped faces out of every later operator, filter, and subtotal", () => {
      // dl1 drops the 1; the later kh2 ranks only the live 6/3/5 (keeps 6+5); the dropped
      // faces stay visible but contribute to no subtotal.
      const result = rollDice("4d6{'fury'}dl1kh2", { random: seq(1, 6, 3, 5) });
      expect(result.total).toBe(11);
      expect(result.subtotals).toEqual([expect.objectContaining({ label: "fury", total: 11 })]);
      expect(result.faces.filter((face) => face.dropped)).toHaveLength(2);
      expect(result.faces).toHaveLength(4);
    });

    it("a dropped face never explodes", () => {
      // The block's do6 drops the 6 before the group-level explosion pass sees the array.
      const result = rollDice("(2d6do6)!", { random: seq(6, 3) });
      expect(result.total).toBe(3);
      expect(result.faces).toHaveLength(2); // no spawn from the dropped 6
    });

    it("a seal consumes its scope's dropped faces", () => {
      // The group seals to one face worth 6+5; the dropped 1 and 3 never surface.
      const result = rollDice("(4d6kh2)s + 2", { random: seq(1, 6, 3, 5) });
      expect(result.total).toBe(13);
      expect(result.faces.map((face) => face.raw)).toEqual([11, 2]);
    });

    it("a dropped sealed face surfaces like any other", () => {
      // Two sealed pairs; kh1 drops the lesser composite - sourceless but shown.
      const result = rollDice("((2d6)s + (2d8)s)kh1", { random: seq(1, 2, 5, 6) });
      expect(result.total).toBe(11);
      expect(result.faces.map((face) => [face.raw, face.sealed ?? false, face.dropped ?? false]))
        .toEqual([[3, true, true], [11, true, false]]);
    });

    it("negation flips a dropped face's shown value too", () => {
      // The d4s join negated; group kh1 keeps the best contribution (a d8).
      const result = rollDice("(2d8 - 2d4)kh1", { random: seq(5, 7, 2, 1) });
      expect(result.total).toBe(7);
      const dropped = result.faces.filter((face) => face.dropped).map((face) => face.value);
      expect(dropped).toEqual([5, -2, -1]);
    });
  });

  // ── Combining: +/-, constants, groups, open/sealed ─────────────────────────
  describe("combining blocks", () => {
    it("adds a constant as a single face in the array", () => {
      expect(roll("2d6+3", seq(2, 5)).total).toBe(10);
      expect(roll("4d8 + 1 + 2d6", seq(3, 3, 3, 3, 2, 4)).total).toBe(19); // 12 + 1 + 6
    });

    it("accepts zero as a constant modifier", () => {
      expect(roll("2d6+0", seq(2, 5)).total).toBe(7); // PbtA with a +0 stat
      // Still a face like any other: it weighs one item in a count.
      expect(roll("(2d6+0)c", seq(2, 5)).total).toBe(3);
    });

    it("counts a constant as one item, like any other face", () => {
      expect(roll("(2d6+3)c", seq(2, 5)).total).toBe(3);
    });

    it("counts items in the array, whatever produced them", () => {
      // `c` is the array length - a die, a kept die, and a constant each weigh one.
      expect(roll("(1d6 + 2d8)c", seq(3, 5, 5)).total).toBe(3);
      expect(roll("(4d6kh + 2d8)c", seq(1, 2, 3, 4, 5, 5)).total).toBe(3); // 4d6kh → one item
    });

    it("subtracts by negating the joined operand's faces", () => {
      expect(roll("2d8 - 2d4", seq(5, 7, 3, 1)).total).toBe(8); // 12 − 4
      expect(roll("10 - 2d6", seq(2, 5)).total).toBe(3);
    });

    it("negates the first operand with a leading minus", () => {
      expect(roll("-3d6", seq(1, 2, 3)).total).toBe(-6);
    });

    it("binds +/- looser than a block's own filters", () => {
      // subtract the *better* of two d4, not the negated faces before keeping.
      expect(roll("2d8 - 2d4kh1", seq(5, 7, 3, 1)).total).toBe(9); // 12 − 3
      expect(roll("10 - 4d6kh1", seq(1, 2, 3, 6)).total).toBe(4); // 10 − 6
    });

    it("groups so an operator or filter spans members", () => {
      expect(roll("(2d20 + 3d6)kh1 + 3d8", seq(4, 17, 1, 2, 3, 5, 5, 5)).total).toBe(32);
      expect(roll("(1d20 + 1d6)!kh1", seq(20, 6, 3, 2)).total).toBe(20);
    });

    it("keeps operands open unless a final operator seals them", () => {
      // open: all four dice are separate items in the outer array.
      expect(roll("2d6 + 2d8", seq(2, 5, 3, 4)).total).toBe(14);
      expect(roll("(2d6 + 2d8)c", seq(2, 5, 3, 4)).total).toBe(4);
      // sealed: (2d6)s collapses its two dice into one item, so the array holds 3, not 4.
      expect(roll("((2d6)s + 2d8)c", seq(2, 5, 3, 4)).total).toBe(3);
    });

    it("seals to keep the better *total*, not the better single face", () => {
      // (2d6)s = 3, (2d8)s = 11 - kh1 compares the sealed pair sums.
      expect(roll("((2d6)s + (2d8)s)kh1", seq(1, 2, 6, 5)).total).toBe(11);
    });

    it("keeps a unanimous appearance on a sealed face", () => {
      // Two fire dice and a constant seal to one sourceless fire face - the constant doesn't veto.
      const result = roll("(2d6{'fire'}+3)s + 1d4", seq(2, 5, 3));
      expect(result.total).toBe(13);
      expect(result.subtotals).toEqual([expect.objectContaining({ label: "fire", total: 10 })]);
    });

    it("allows `i` only as the outermost reduction", () => {
      expect(() => roll("2d6i + 3")).toThrow(DiceError);
      expect(() => roll("((2d6)i)c")).toThrow(DiceError);
    });
  });

  // ── Order and errors ───────────────────────────────────────────────────────
  describe("order and errors", () => {
    it("requires operators before filters before the final operator", () => {
      expect(() => roll("6d6kh3!")).toThrow(DiceError); // operator after filter
      expect(() => roll("6d6skh1")).toThrow(DiceError); // final before filter
      expect(roll("6d6!kh3", seq(6, 1, 2, 3, 4, 5, 2)).total).toBeTypeOf("number"); // legal order
    });

    it("evaluates a class strictly left-to-right", () => {
      // explode, keep highest 3 {6,5,4}, then keep the lowest of those → 4.
      expect(roll("6d6!kh3kl1", seq(1, 2, 3, 4, 5, 6, 2)).total).toBe(4);
    });

    it("allows only one final operator", () => {
      expect(() => roll("6d6sc")).toThrow(DiceError);
    });

    it("rejects a doubled sign (a constant is unsigned)", () => {
      expect(() => roll("2d6+-3")).toThrow(DiceError);
    });

    it("rejects zero counts", () => {
      expect(() => roll("0d6")).toThrow(DiceError);
      expect(() => roll("6d6kh0")).toThrow(DiceError);
      expect(() => roll("4d6rl0")).toThrow(DiceError);
    });

    it("binds a threshold's minus sign greedily", () => {
      // Whitespace is insignificant: this is ko(−1) keeping everything, not a subtraction.
      expect(roll("2d6 ko - 1", seq(2, 5)).total).toBe(7);
    });

    it("rejects control characters inside a quoted string (see the EBNF grammar)", () => {
      // Built from char codes so no literal control byte lives in this file.
      const nul = String.fromCharCode(0);
      const newline = String.fromCharCode(10);
      const del = String.fromCharCode(127);
      expect(() => roll(`d['a${nul}b','c']`)).toThrow(DiceError);
      expect(() => roll(`2d6{'fire${newline}'}`)).toThrow(DiceError);
      expect(() => roll(`d['x${del}','y']`)).toThrow(DiceError);
      expect(roll("d['a b','c']", seq(1)).labels).toEqual(["a b"]); // plain spaces are content
    });
  });

  // ── Limits and safety ──────────────────────────────────────────────────────
  describe("limits and safety", () => {
    it("bounds the total dice rolled across the formula", () => {
      expect(() => roll("101d6")).toThrow(DiceError);
      expect(() => roll("60d6+60d6")).toThrow(DiceError);
    });

    it("caps unbounded explosion instead of hanging", () => {
      expect(() => roll("1d2!", maxFace)).toThrow(DiceError);
      expect(() => roll("1d2*", maxFace)).toThrow(DiceError);
    });

    it("caps an until-reroll chain instead of hanging", () => {
      // d2 rru1 is legal (a 2 escapes), but this RNG never rolls one.
      expect(() => roll("1d2rru1", () => 1)).toThrow(DiceError);
    });

    it("bounds formula length", () => {
      // 41 faces and legal values - only the 200-character cap rejects this one.
      expect(() => roll(`d[${"1000,".repeat(40)}1000]`)).toThrow(DiceError);
    });

    // `LIMITS` is the number an application shows its users, so each exported cap is
    // pinned to the engine's real behavior: legal at the cap, rejected one past it.
    it("exports caps that match what it enforces", () => {
      expect(Object.isFrozen(LIMITS)).toBe(true);

      expect(roll(`${LIMITS.draws}d6`).values).toHaveLength(LIMITS.draws);
      expect(() => roll(`${LIMITS.draws + 1}d6`)).toThrow(DiceError);

      expect(roll(`d${LIMITS.value}`, seq(7)).total).toBe(7);
      expect(() => roll(`d${LIMITS.value + 1}`)).toThrow(DiceError);
      expect(roll(`${LIMITS.value}`).total).toBe(LIMITS.value);
      expect(() => roll(`${LIMITS.value + 1}`)).toThrow(DiceError);

      expect(roll(`d[1x${LIMITS.faces}]`).total).toBe(1); // every face valued 1
      expect(() => roll(`d[1x${LIMITS.faces + 1}]`)).toThrow(DiceError);

      const ones = (n: number) => Array.from({ length: n }, () => "1").join("+");
      expect(roll(ones(LIMITS.operands)).total).toBe(LIMITS.operands);
      expect(() => roll(ones(LIMITS.operands + 1))).toThrow(DiceError);

      // Whitespace is stripped before measuring, but a quoted name is content.
      const named = (n: number) => `2d6{'${"a".repeat(n - 7)}'}`;
      expect(roll(named(LIMITS.length), seq(1, 1)).total).toBe(2);
      expect(() => roll(named(LIMITS.length + 1))).toThrow(DiceError);
    });
  });

  // ── Worked examples (the spec's own table, executable) ─────────────────────
  describe("worked examples", () => {
    it("Savage Worlds - trait + wild, both acing, keep higher", () => {
      // (1d8* + 1d6*)kh1 : d8 aces 8→3 = 11, wild d6 = 4 → keep 11.
      expect(roll("(1d8* + 1d6*)kh1", seq(8, 4, 3)).total).toBe(11);
    });

    it("Daggerheart - two labeled duality dice, interpretation left to players", () => {
      const result = roll("(1d12{'hope'} + 1d12{'fear'})i", seq(10, 3));
      expect(result.values).toEqual([10, 3]);
      expect(result.labels).toEqual(["hope", "fear"]);
    });

    it("D&D advantage / roll-under advantage", () => {
      expect(roll("2d20kh1", seq(4, 17)).total).toBe(17);
      expect(roll("2d100kl1", seq(80, 25)).total).toBe(25);
    });

    it("success pool - count vs sum", () => {
      expect(roll("6d6ko6c", seq(6, 3, 6, 1, 6, 5)).total).toBe(3);
      expect(roll("6d6ko6", seq(6, 3, 6, 1, 6, 5)).total).toBe(18);
    });

    it("min as sugar for a shifted face list", () => {
      expect(roll("4d6min3", seq(1, 2, 6, 5)).total).toBe(17); // [3,3,6,5]
    });

    it("d66 - a tens die and a units die", () => {
      expect(roll("d[10,20,30,40,50,60] + d6", seq(4, 3)).total).toBe(43);
      expect(roll("d[10..60:10] + d6", seq(4, 3)).total).toBe(43); // range sugar, same die
    });

    it("resistance and vulnerability - scale the sealed total", () => {
      expect(roll("(2d8+3)s/2", seq(5, 3)).total).toBe(5); // 11/2 rounded down
      expect(roll("(2d8+3)sx2", seq(5, 3)).total).toBe(22);
    });

    it("World of Darkness 9-again - explode on 9+, count the 8+ successes", () => {
      // base 9,3,8; the 9 chains 10 → 2; successes are 9, 8, 10.
      expect(roll("3d10!o9ko8c", seq(9, 3, 8, 10, 2)).total).toBe(3);
    });

    it("exploding pool, then drop the lowest of whatever grew", () => {
      // 4d6! grows to five faces; dl1 drops the 1.
      expect(roll("4d6!dl1", seq(6, 1, 3, 2, 4)).total).toBe(15);
    });

    it("net successes as weighted faces - 8+ counts one, 1s subtract one", () => {
      expect(roll("10d[-1,0,0,0,0,0,0,1,1,1]", seq(1, 8, 9, 10, 2, 3, 4, 5, 6, 7)).total).toBe(2);
      expect(roll("10d[-1,0x6,1x3]", seq(1, 8, 9, 10, 2, 3, 4, 5, 6, 7)).total).toBe(2); // repetition sugar
    });

    it("reroll 1s and 2s until none remain", () => {
      // 4d6rru2: dice showing 1 or 2 chain fresh rolls until each clears the threshold.
      expect(roll("4d6rru2", seq(1, 5, 2, 6, 2, 3, 4)).total).toBe(18); // 3 + 5 + 4 + 6
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `validateDice` - the parse phase alone, for input fields and stored macros.
// ─────────────────────────────────────────────────────────────────────────────

describe("validateDice", () => {
  // Any draw during validation is a contract violation, so the RNG refuses to serve one.
  const noDraws = () => {
    throw new Error("validateDice drew a die");
  };
  const check = (input: string) => validateDice(input, { random: noDraws });

  it("returns null for a well-formed formula", () => {
    for (const formula of ["2d20kh1 + 5", "6d10ko8c", "(2d8+3)s/2", "(1d12{'hope'} + 1d12{'fear'})i", "d[10..60:10] + d6"])
      expect(check(formula)).toBeNull();
  });

  it("returns the DiceError the same input would throw, not a boolean", () => {
    const error = check("6d6kh3!"); // Order and errors: operators may not follow filters
    expect(error).toBeInstanceOf(DiceError);
    expect(() => roll("6d6kh3!")).toThrow(error!.message);
  });

  it("rejects empty and blank input", () => {
    expect(check("")).toBeInstanceOf(DiceError);
    expect(check("   ")).toBeInstanceOf(DiceError);
  });

  it("runs the static checks, not just syntax", () => {
    expect(check("d6!o7")).toBeInstanceOf(DiceError); // Limits and safety: trigger no face can meet
    expect(check("d6!o1")).toBeInstanceOf(DiceError); // Limits and safety: unbounded glyph that never halts
    expect(check("d6rru6")).toBeInstanceOf(DiceError); // Limits and safety: until-reroll that never halts
    expect(check("2d6 + 2d8i")).toBeInstanceOf(DiceError); // Combining blocks: `i` must be the outermost reduction
    expect(check("2d6skh1")).toBeInstanceOf(DiceError); // Order and errors: filter after a final operator
    expect(check("d6!!o1")).toBeNull(); // a bounded glyph is always finite
  });

  it("counts base dice across the whole formula, before any roll", () => {
    expect(check("60d6 + 60d6")).toBeInstanceOf(DiceError);
    expect(check("(40d6 + 40d6)s + 40d6")).toBeInstanceOf(DiceError); // groups count too
    expect(check("50d6 + 50d6")).toBeNull(); // exactly at the cap
    expect(() => roll("60d6+60d6")).toThrow(DiceError); // and rollDice agrees
  });

  it("resolves color tokens against the palette it is given", () => {
    expect(check("2d6{#brand}")).toBeInstanceOf(DiceError);
    expect(validateDice("2d6{#brand}", { palette: { brand: "#7950f2" } })).toBeNull();
    expect(check("2d6{#f0f}")).toBeNull(); // hex needs no palette
  });

  it("accepts formulas that only the dice can fail, leaving those to roll time", () => {
    expect(check("1d2!")).toBeNull(); // legal; may still hit the chain cap
    expect(() => roll("1d2!", maxFace)).toThrow(DiceError);
  });
});

// `index` is a 0-based offset into the notation as passed in, whitespace included.
describe("error position", () => {
  const at = (input: string) => validateDice(input)?.index;

  it("points at the character the formula went wrong on", () => {
    expect(at("6d6kh3!")).toBe(6); // the operator that follows a filter
    expect(at("2d6}")).toBe(3); // first character the parse could not consume
    expect(at("(2d6+d8){#red}")).toBe(8); // the appearance a group may not carry
    expect(at("3{#red}")).toBe(1);
    expect(at("d[3..1]")).toBe(5); // the range end, not the range
    expect(at("2d6{#zzz}")).toBe(4); // the color token, not the character that failed to match
  });

  it("points at the token's start, not at wherever scanning stopped", () => {
    expect(at("2000d6")).toBe(0); // the count
    expect(at("2d6 + 9999")).toBe(6); // the constant
    expect(at("d[1,2] min 2000")).toBe(11); // the clamp bound
    expect(at("2d6{'unclosed}")).toBe(4); // the opening quote
    expect(at("2d6{#red,#blue}")).toBe(9); // the second color, the one that duplicates
  });

  it("points into the text for checks that run after the parse", () => {
    expect(at("d6!o7")).toBe(2); // the explosion glyph that can never trigger
    expect(at("d6rru6")).toBe(2); // the reroll that would never stop
    expect(at("d6!!!")).toBe(4); // the second explosion operator
    expect(at("1d6 + (2d6i) + 3")).toBe(10); // the misplaced `i` itself
  });

  it("runs out of input at the offset one past the end", () => {
    for (const truncated of ["d", "2d", "(2d6", "d[1,2", "4d6rl", "d6min"])
      expect(at(truncated)).toBe(truncated.length);
  });

  it("has no position for the failures no single character causes", () => {
    // Formula-wide caps: the sum across every block, and the length of the whole string.
    expect(at("60d6 + 60d6")).toBeUndefined();
    expect(at("2d6 + ".repeat(60) + "2d6")).toBeUndefined(); // over the length cap
    // The length cap is measured with whitespace stripped, so 40 operands parse and 60 do not.
    expect(at("2d6 + ".repeat(40) + "2d6")).toBe(124);
  });

  it("carries the same position whether the formula was rolled or validated", () => {
    for (const bad of ["6d6kh3!", "d6!o7", "1d6 + (2d6i) + 3", "(2d6"]) {
      let thrown: DiceError | undefined;
      try {
        roll(bad);
      } catch (error) {
        thrown = error as DiceError;
      }
      expect(thrown).toBeInstanceOf(DiceError);
      expect(thrown!.index).toBe(at(bad));
    }
  });

  it("is a DiceError by name, so a caught error reads as one", () => {
    expect(validateDice("6d6kh3!")!.name).toBe("DiceError");
    expect(String(validateDice("6d6kh3!"))).toBe("DiceError: Invalid notation");
  });
});
