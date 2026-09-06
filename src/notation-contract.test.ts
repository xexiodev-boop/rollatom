import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DiceError, rollDice, validateDice, type NotationResult } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Property-based contract tests for RollAtom. Generated formulas and RNG streams exercise
// invariants that must hold for every result. This file imports only the engine;
// `dice-notation.test.ts` contains the example-based specification.
// ─────────────────────────────────────────────────────────────────────────────

// A deterministic RNG driven by a fast-check-generated stream of naturals.
// Cycles if a formula draws more than the stream holds (explosions).
const rngFrom = (stream: number[]) => {
  let i = 0;
  return (faceCount: number) => (stream[i++ % stream.length] % faceCount) + 1;
};

const seedArb = fc.array(fc.nat({ max: 1 << 30 }), { minLength: 40, maxLength: 40 });

// Generated formulas: canonical block order (count · d · faces · ops · filters · final),
// joined with +/-. Triggerless explosions and in-range thresholds keep every generated
// formula statically valid; the engine's own caps (draws, chain) may still throw DiceError
// mid-roll, which the properties treat as a legal outcome.
const blockArb = fc
  .record({
    count: fc.integer({ min: 1, max: 6 }),
    faces: fc.constantFrom<number | string>(4, 6, 8, 10, 12, 20, "[1..6]", "[2..20:2]", "[0x3,1x3]"),
    op: fc.constantFrom("", "!!", "**", "ru2", "rru2", "rl1", "min2", "max5"),
    filter: fc.constantFrom("", "kh1", "kl2", "km1", "dh1", "dl1", "ko3", "du2"),
    final: fc.constantFrom("", "s", "c", "sx2", "s/2", "s/3u", "c/2u"),
  })
  .map((b) => `${b.count}d${b.faces}${b.op}${b.filter}${b.final}`);

const formulaArb = fc
  .record({
    blocks: fc.array(blockArb, { minLength: 1, maxLength: 4 }),
    signs: fc.array(fc.constantFrom("+", "-"), { minLength: 3, maxLength: 3 }),
    constant: fc.option(fc.integer({ min: 0, max: 50 }), { nil: undefined }),
  })
  .map(({ blocks, signs, constant }) => {
    let src = blocks[0];
    for (let i = 1; i < blocks.length; i += 1) src += ` ${signs[i - 1]} ${blocks[i]}`;
    if (constant !== undefined) src += ` + ${constant}`;
    return src;
  });

// Rolls, treating the engine's runtime caps as a legal (skipped) outcome.
function tryRoll(formula: string, stream: number[]): NotationResult | undefined {
  try {
    return rollDice(formula, { random: rngFrom(stream) });
  } catch (error) {
    if (error instanceof DiceError) return undefined;
    throw error;
  }
}

describe("engine contract (properties)", () => {
  it("total is the (scaled) reduction of the surviving values, in every mode", () => {
    fc.assert(
      fc.property(formulaArb, seedArb, (formula, stream) => {
        const result = tryRoll(formula, stream);
        if (!result) return;
        const reduction = result.mode === "count" ? result.values.length : result.values.reduce((a, b) => a + b, 0);
        const scale = result.scale;
        const scaled = !scale
          ? reduction
          : scale.op === "x"
            ? reduction * scale.by
            : scale.up
              ? Math.ceil(reduction / scale.by)
              : Math.floor(reduction / scale.by);
        expect(result.total).toBe(scaled);
        expect(Number.isInteger(result.total)).toBe(true);
      }),
    );
  });

  it("values are exactly the undropped faces' signed values, in order", () => {
    fc.assert(
      fc.property(formulaArb, seedArb, (formula, stream) => {
        const result = tryRoll(formula, stream);
        if (!result) return;
        const live = result.faces.filter((f) => !f.dropped);
        expect(result.values).toEqual(live.map((f) => f.value));
        for (const face of result.faces) {
          expect(face.value).toBe(face.sign * face.raw);
          expect(Math.abs(face.sign)).toBe(1);
        }
      }),
    );
  });

  it("a die face's raw value is its history resolved (absent clamps)", () => {
    const clampFree = formulaArb.filter((f) => !f.includes("min") && !f.includes("max"));
    fc.assert(
      fc.property(clampFree, seedArb, (formula, stream) => {
        const result = tryRoll(formula, stream);
        if (!result) return;
        for (const face of result.faces) {
          if (!face.faces || face.history.length === 0) continue;
          const chained = face.history.reduce((a, b) => a + b, 0);
          // Vertical chains sum; every other source face carries a single-entry history.
          if (face.history.length === 1) expect(face.raw).toBe(face.history[0]);
          else expect(face.raw).toBe(chained);
        }
      }),
    );
  });

  it("a plain pool stays within its bounds and rolls the stated number of dice", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.constantFrom(4, 6, 8, 10, 12, 20),
        seedArb,
        (count, faces, stream) => {
          const result = rollDice(`${count}d${faces}`, { random: rngFrom(stream) });
          expect(result.faces).toHaveLength(count);
          expect(result.total).toBeGreaterThanOrEqual(count);
          expect(result.total).toBeLessThanOrEqual(count * faces);
        },
      ),
    );
  });

  it("is deterministic: the same formula and RNG stream reproduce the same result", () => {
    fc.assert(
      fc.property(formulaArb, seedArb, (formula, stream) => {
        expect(tryRoll(formula, stream)).toEqual(tryRoll(formula, stream));
      }),
    );
  });

  it("throws DiceError and nothing else, whatever the input string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), seedArb, (input, stream) => {
        try {
          rollDice(input, { random: rngFrom(stream) });
        } catch (error) {
          expect(error).toBeInstanceOf(DiceError);
        }
      }),
    );
  });

  it("an error's position, when it has one, is a real offset into the input", () => {
    // One past the end is legal: that is where running out of input points.
    fc.assert(
      fc.property(fc.oneof(formulaArb, fc.string({ maxLength: 60 })), (input) => {
        const error = validateDice(input);
        if (error?.index === undefined) return;
        expect(Number.isInteger(error.index)).toBe(true);
        expect(error.index).toBeGreaterThanOrEqual(0);
        expect(error.index).toBeLessThanOrEqual(input.length);
      }),
    );
  });

  it("reports the same position whether the formula was validated or rolled", () => {
    fc.assert(
      fc.property(fc.oneof(formulaArb, fc.string({ maxLength: 60 })), seedArb, (input, stream) => {
        const error = validateDice(input);
        if (!error) return;
        try {
          rollDice(input, { random: rngFrom(stream) });
          expect.unreachable("a statically rejected formula rolled");
        } catch (thrown) {
          expect((thrown as DiceError).index).toBe(error.index);
        }
      }),
    );
  });

  it("validateDice accepts exactly what survives the parse phase, whatever the input string", () => {
    // The caps a roll can still hit after a formula validates: they depend on the dice, not the
    // text, so they are the only failures `validateDice` is allowed to miss.
    const runtimeCaps = ["Too many dice", "Explosion limit reached", "Reroll limit reached"];
    fc.assert(
      fc.property(fc.oneof(formulaArb, fc.string({ maxLength: 60 })), seedArb, (input, stream) => {
        const error = validateDice(input);
        expect(error === null || error instanceof DiceError).toBe(true);
        if (error) {
          // Rejected statically: the roll throws the same error, before drawing anything.
          expect(() => rollDice(input, { random: rngFrom(stream) })).toThrow(error.message);
          return;
        }
        try {
          rollDice(input, { random: rngFrom(stream) });
        } catch (thrown) {
          expect(runtimeCaps).toContain((thrown as DiceError).message);
        }
      }),
    );
  });

  it("keep filters keep at most their count; drop filters drop at most theirs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        fc.constantFrom("kh", "kl", "km"),
        seedArb,
        (count, keep, mode, stream) => {
          const result = rollDice(`${count}d6${mode}${keep}`, { random: rngFrom(stream) });
          expect(result.values).toHaveLength(Math.min(keep, count)); // clamped, never throws
          expect(result.faces).toHaveLength(count);
        },
      ),
    );
  });
});
