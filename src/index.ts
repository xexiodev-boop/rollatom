// RollAtom implements the dice grammar specified in `docs/GRAMMAR.md`. Each rolled face records its
// raw roll, sign, source, appearance, and chain history. `dice-notation.test.ts` contains the
// example-based specification, and `notation-contract.test.ts` checks its invariants. The
// runtime has no dependencies beyond Web Crypto; applications provide palettes and other
// integration settings through `RollOptions`.

/**
 * Why a formula was rejected, stable across 1.x. Each `limit-` code names the `LIMITS` key it
 * enforces. `syntax` covers every malformed formula; any other code means the formula reads
 * correctly but breaks a rule.
 */
export type DiceErrorCode =
  | "syntax"
  | "unknown-color"
  | "unknown-variable"
  | "dead-trigger"
  | "endless-trigger"
  | "limit-draws"
  | "limit-chain"
  | "limit-length"
  | "limit-operands"
  | "limit-faces"
  | "limit-value"
  | "result-too-large"
  | "invalid-roll";

export class DiceError extends Error {
  /** The rule that was broken. Covered by the contract; `message` is not. */
  readonly code: DiceErrorCode;
  /** 0-based offset of the character at fault; absent for the formula-wide and roll-time caps. */
  readonly index?: number;
  /**
   * For a `syntax` error at a character that cannot start a token there: the tokens that could,
   * such as `"+"`, `"kh"`, or `"number"`. The list may grow in any release.
   */
  declare readonly expected?: string[];

  constructor(message: string, code: DiceErrorCode, index?: number, expected?: string[]) {
    super(message);
    this.name = "DiceError";
    this.code = code;
    this.index = index;
    if (expected?.length) this.expected = expected;
  }
}

/**
 * What a warning from `lintDice` is about, stable across 1.x:
 * - `inert-operator`: an operator that can never change a roll (`d6min1`, `d6ru0`, `((2d6)s)rl1`).
 * - `inert-filter`: a keep filter that always keeps every face (`2d20kh2`).
 * - `empty-filter`: a drop filter that always drops every face (`2d6dl2`).
 * - `inert-scale`: a scale of 1 (`sx1`, `s/1`).
 */
export type DiceWarningCode = "inert-operator" | "inert-filter" | "empty-filter" | "inert-scale";

/** A formula that rolls but contains a step that changes nothing. Returned by `lintDice`. */
export interface DiceWarning {
  /** What is wrong. Covered by the contract; `message` is not. */
  code: DiceWarningCode;
  message: string;
  /** 0-based offset of the step's first character. */
  index: number;
}

// ─── Palette ─────────────────────────────────────────────────────────────────
// Neutral defaults for `#name` colors and subtotal auto-colors. Frozen: an application supplies
// its own via `RollOptions`; nothing app-specific lives here.

export const DEFAULT_PALETTE: Readonly<Record<string, string>> = Object.freeze({
  red: "#cc3333",
  orange: "#cc7733",
  gold: "#ccaa33",
  yellow: "#cccc44",
  green: "#4d9944",
  teal: "#339999",
  blue: "#3366cc",
  purple: "#8855cc",
  pink: "#cc6699",
  white: "#eeeeee",
  grey: "#888888",
  gray: "#888888",
  black: "#333333",
});

const AUTO_COLORS = ["#cc3333", "#cc7733", "#ccaa33", "#4d9944", "#339999", "#3366cc", "#8855cc", "#cc6699", "#cccc44", "#888888"];

// The same label receives the same color in every roll.
function defaultAutoColor(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return AUTO_COLORS[hash % AUTO_COLORS.length];
}

// ─── Public result ───────────────────────────────────────────────────────────

export interface NotationSubtotal {
  label: string;
  /** The name's surviving faces: counted under `mode: "count"`, else summed. Never scaled. */
  total: number;
  color: string;
}

/** A reducer's scale (see Final operators): `xN` multiplies the reduction, `/N` divides it. */
export interface NotationScale {
  /** `"x"` multiplies the reduction by `by`; `"/"` divides it. */
  op: "x" | "/";
  by: number;
  /** Division rounds down (floor) unless set; set means round up (ceiling). */
  up?: true;
}

// Public, application-independent data for one rolled face. It provides the data a renderer
// needs without exposing the private `Atom`. `values` and `labels` project the surviving faces;
// `faces` also includes filtered faces, marked as dropped, along with source, chain, and
// appearance data. Adapters may map this contract to application-specific shapes.
export interface NotationFace {
  /** This face's signed contribution to `total` and its entry in `values`. */
  value: number;
  sign: 1 | -1;
  /**
   * The number the die shows, before `sign`: a vertical explosion's summed chain, else the roll.
   * Not unsigned; a face list may hold negatives, so a minus `dF` is `raw: -1` with `sign: 1`.
   */
  raw: number;
  /** The raw rolls behind `raw`, in order (`[first, ...explosions]`). Empty for constants/seals. */
  history: number[];
  /** Raw rolls a reroll operator discarded, in order. Present only when the face rerolled. */
  rerolls?: number[];
  /** The source die's face count, for choosing an icon. Absent for constants and sealed faces. */
  faces?: number;
  /** A labeled face's own label (a Fate ±/blank, a `d['cat','dog']` side). */
  label?: string;
  /** The `#name` appearance the die carries (drives subtotal grouping). */
  name?: string;
  /** The resolved hex color from the die's appearance, when it has one. */
  color?: string;
  /** True for a face produced by an `s`/`c` seal: sourceless, but not a bare constant. */
  sealed?: boolean;
  /** True for a filtered face retained in `faces` but excluded from `values` and `total`. */
  dropped?: boolean;
}

export interface NotationResult {
  notation: string;
  total: number;
  /** Final-array face values (signed), in roll order, including constants and sealed faces. */
  values: number[];
  /** Per-face labels; present when any face has a string label or a name, and always for `i`. */
  labels?: string[];
  subtotals?: NotationSubtotal[];
  /** The top-level reduction: implicit/explicit sum, count, or individual. */
  mode: "sum" | "count" | "individual";
  /** The outermost reducer's scale, when it carries one. `total` already includes it. */
  scale?: NotationScale;
  /**
   * Every face in roll order: the final array `values` projects, plus the faces filters
   * dropped along the way (marked `dropped`, contributing nothing to `total`). Faces dropped
   * inside a sealed (`s`/`c`) scope are consumed by the seal and never surface.
   */
  faces: NotationFace[];
}

/** A roll source: returns a 1-based face index in `[1, faceCount]`. */
export type RandomInt = (faceCount: number) => number;

export interface RollOptions {
  /** Returns a 1-based face index in [1, faceCount]. Defaults to a CSPRNG. */
  random?: RandomInt;
  /** Color names behind `#name`, matched whatever their case. Defaults to `DEFAULT_PALETTE`. */
  palette?: Readonly<Record<string, string>>;
  /** Color for a named subtotal with no explicit color. Stable per label by default. */
  autoColor?: (label: string) => string;
  /**
   * Caps that replace those in `LIMITS`, key by key; a key left out keeps its default. Each must
   * be a positive safe integer, and `faces` at least 2, or the call throws `RangeError`.
   */
  limits?: Readonly<Partial<Limits>>;
  /**
   * Values behind `@name` in a formula, matched whatever their case. Read when the formula is
   * parsed. A value a formula uses must be a safe integer, or the call throws `RangeError`.
   */
  vars?: Readonly<Record<string, number>>;
}

/**
 * Roll-time options for an already-compiled formula. `palette`, `limits`, and `vars` are absent
 * because all three are applied when the formula is compiled, so none passed here could take effect.
 */
export type CompiledRollOptions = Omit<RollOptions, "palette" | "limits" | "vars">;

/**
 * A formula parsed once and rollable many times, returned by `compileDice`. It keeps nothing
 * from one roll to the next, so a single instance can be stored, shared, and rolled repeatedly.
 */
export interface CompiledDice {
  /** The formula, trimmed: the string every result carries as `notation`. */
  readonly notation: string;
  /** Rolls the formula. Throws `DiceError` for the roll-time limits (see `validateDice`). */
  roll(options?: CompiledRollOptions): NotationResult;
}

// Web Crypto is asked for entropy in batches rather than once per draw. Allocated on first use,
// so importing the module allocates nothing.
const POOL_WORDS = 64;
let pool: Uint32Array | undefined;
let nextWord = POOL_WORDS;

// A face index in [1, max] from a source of uint32 words. Rejection sampling, to avoid modulo
// bias: a word at or above the ceiling is discarded and the next one taken.
function uniformIndex(max: number, source: () => number): number {
  if (!Number.isSafeInteger(max) || max < 1 || max > 0x1_0000_0000) throw new DiceError("Invalid die", "invalid-roll");
  const ceiling = Math.floor(0x1_0000_0000 / max) * max;
  let word: number;
  do word = source();
  while (word >= ceiling);
  return (word % max) + 1;
}

const secureRandom: RandomInt = (max) =>
  uniformIndex(max, () => {
    const words = (pool ??= new Uint32Array(POOL_WORDS));
    if (nextWord >= POOL_WORDS) {
      crypto.getRandomValues(words);
      nextWord = 0;
    }
    return words[nextWord++];
  });

/**
 * A reproducible roll source: the same seed gives the same draws, so a stored seed replays a roll.
 * Each call returns a fresh stream; reusing one stream across rolls continues it. Not
 * cryptographic: for rolls a player must not predict, keep the default source.
 *
 * Throws `RangeError` unless `seed` is a safe integer.
 */
export function seededRandom(seed: number): RandomInt {
  if (!Number.isSafeInteger(seed)) throw new RangeError("seed must be a safe integer");
  // Both halves of a 53-bit seed feed the 32-bit state, so seeds that differ only in their high
  // bits still differ.
  let state = (seed >>> 0) ^ Math.imul(Math.floor(seed / 0x1_0000_0000) >>> 0, 0x9e3779b9);
  // mulberry32.
  const source = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return (max) => uniformIndex(max, source);
}

// ─── Limits (spec: Limits and safety) ────────────────────────────────────────

export interface Limits {
  /** Dice one formula may draw in total: base rolls, explosions, and rerolls together. */
  draws: number;
  /** Rolls one face may chain under an unbounded explosion or an until-reroll. */
  chain: number;
  /** Formula characters, counted with token-separating whitespace stripped. */
  length: number;
  /** Operands one expression may join with `+` and `-`. */
  operands: number;
  /** Faces a face list may hold once ranges and repetitions expand. The floor is 2. */
  faces: number;
  /** Magnitude cap on a face value, constant, clamp bound, scale factor, and `dN` size. */
  value: number;
}

/**
 * The default caps, exposed so an application can report them (a character counter, a "too
 * many dice" hint) without repeating the numbers. A call replaces any of them through
 * `RollOptions.limits`; this object is frozen, so the defaults read the same everywhere.
 */
export const LIMITS: Readonly<Limits> = Object.freeze({
  draws: 100,
  chain: 50,
  length: 200,
  operands: 20,
  faces: 100,
  value: 1000,
});

// The caps one call runs under: the defaults with the caller's overrides laid over them.
// `null` reads as no overrides, like `undefined`.
function resolveLimits(overrides: Readonly<Partial<Limits>> | null | undefined): Readonly<Limits> {
  if (overrides == null) return LIMITS;
  const limits = { ...LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(LIMITS, key)) throw new RangeError(`Unknown limit: ${key}`);
    const value = overrides[key as keyof Limits];
    if (value === undefined) continue;
    // A face list below two faces is malformed whatever the cap, so the cap cannot go under it.
    const floor = key === "faces" ? 2 : 1;
    if (!Number.isSafeInteger(value) || value < floor) throw new RangeError(`limits.${key} must be an integer of at least ${floor}`);
    limits[key as keyof Limits] = value;
  }
  return limits;
}

// ─── AST ─────────────────────────────────────────────────────────────────────

interface FaceSpec {
  value: number;
  label?: string;
}

interface DieSpec {
  faces: FaceSpec[];
  maxValue: number;
}

interface Appearance {
  name?: string;
  color?: string;
  /** The color as written, `#red` or `#f0f`, for `explainDice`. */
  token?: string;
}

type Final = "s" | "c" | "i";

type Op =
  | { kind: "clamp"; low: boolean; bound: number; at: number }
  | { kind: "explode"; horizontal: boolean; unbounded: boolean; trigger?: number; at: number }
  | { kind: "rerollValue"; under: boolean; bound: number; until?: true; at: number }
  | { kind: "rerollRank"; low: boolean; count: number; at: number };

type Filter =
  | { kind: "rank"; mode: "kh" | "kl" | "km" | "dh" | "dl"; count: number; at: number }
  | { kind: "value"; keep: boolean; over: boolean; bound: number; at: number };

interface BlockNode {
  kind: "block";
  count: number;
  die: DieSpec;
  appearance: Appearance;
  ops: Op[];
  filters: Filter[];
  final?: Final;
  /** Offset of the final glyph, for the `i`-placement error. */
  finalAt?: number;
  scale?: NotationScale;
  /** Offset of the scale, for `lintDice`. */
  scaleAt?: number;
}

interface GroupNode {
  kind: "group";
  expr: ExprNode;
  ops: Op[];
  filters: Filter[];
  final?: Final;
  /** Offset of the final glyph, for the `i`-placement error. */
  finalAt?: number;
  scale?: NotationScale;
  /** Offset of the scale, for `lintDice`. */
  scaleAt?: number;
}

interface ConstNode {
  kind: "const";
  value: number;
}

type OperandNode = BlockNode | GroupNode | ConstNode;

interface ExprNode {
  operands: { sign: 1 | -1; node: OperandNode }[];
  /** On the formula's root only: each name's color, the first explicit one in reading order. */
  colors?: Map<string, string>;
}

// ─── Scanner helpers ─────────────────────────────────────────────────────────
// Whitespace separates tokens but never splits one: `skip` runs between tokens,
// while every token's own characters are matched contiguously.

interface P {
  src: string;
  i: number;
  palette: Readonly<Record<string, string>>;
  /** The palette keyed in lowercase, built on the first `#name`. */
  colors?: Map<string, string>;
  limits: Readonly<Limits>;
  vars?: Readonly<Record<string, number>>;
  /** `vars` keyed in lowercase, built on the first `@name`. */
  varMap?: Map<string, unknown>;
  /** Set while probing which tokens fit at an error, so a probe's own errors are not probed. */
  probe?: true;
}

const SPACE = /\s/;

// Below U+0080, `\s` is the space and the tab-to-CR block; anything higher defers to the regex,
// so the set stays exactly `/\s/`.
function isSpace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && SPACE.test(ch));
}

function skip(p: P) {
  while (p.i < p.src.length && isSpace(p.src[p.i])) p.i += 1;
}

function peek(p: P): string {
  skip(p);
  const ch = p.src[p.i];
  if (ch === undefined) return "";
  const code = ch.charCodeAt(0);
  return code < 65 || (code > 90 && code < 128) ? ch : ch.toLowerCase();
}

// Offset where the next token starts, taken before it is consumed.
function mark(p: P): number {
  skip(p);
  return p.i;
}

// Single exit for parse failures. `at` defaults to the scanner position, the offending character;
// callers pass an earlier mark to point at the start of the rejected token instead.
// A syntax error at the scanner position is an unexpected character, so it lists what fits there.
function fail(p: P, message: string, at: number = p.i, code: DiceErrorCode = "syntax"): never {
  const index = Math.min(at, p.src.length);
  const expected = code === "syntax" && index === p.i && !p.probe ? expectedAt(p, index) : undefined;
  throw new DiceError(message, code, index, expected);
}

// Each candidate is shown by its name and probed with a sample spelling of it.
const CANDIDATES: [shown: string, sample: string][] = [
  ["number", "6"], ["-", "-1"], ["+", "+1"], ["(", "(1)"], [")", ")"], ["d", "d6"], ["f", "f"],
  ["[", "[1,2]"], ["]", "]"], [",", ","], ["..", "..9"], [":", ":1"], ["=", "=1"], ["x", "x1"],
  ["{", "{'a'}"], ["}", "}"], ["'", "'a'"], ["#", "#f0f"], ["@", "@a"], ["!", "!"], ["!!", "!!"], ["*", "*"],
  ["**", "**"], ["o", "o1"], ["min", "min1"], ["max", "max1"], ["ru", "ru1"], ["ro", "ro1"],
  ["rru", "rru1"], ["rro", "rro1"], ["rl", "rl1"], ["rh", "rh1"], ["kh", "kh"], ["kl", "kl"],
  ["km", "km"], ["dh", "dh"], ["dl", "dl"], ["ko", "ko1"], ["ku", "ku1"], ["do", "do1"],
  ["du", "du1"], ["s", "s"], ["c", "c"], ["i", "i"], ["/", "/1"], ["u", "u"],
];

// The tokens that could start at `index`: each candidate is appended to the text before it, after
// a space so it cannot merge into the token before, and kept when the parse reads all of it, runs
// out of text right after it, or stops on a rule other than syntax.
function expectedAt(p: P, index: number): string[] {
  const before = p.src.slice(0, index) + " ";
  const start = before.length;
  return CANDIDATES.filter(([, sample]) => {
    const probe: P = { ...p, src: before + sample, i: 0, probe: true };
    try {
      parseExpr(probe);
      return probe.i === probe.src.length;
    } catch (error) {
      if (!(error instanceof DiceError)) throw error;
      const at = error.index ?? Infinity;
      return at >= probe.src.length || (error.code !== "syntax" && at >= start);
    }
  }).map(([shown]) => shown);
}

// Every `word` passed here is lowercase ASCII, so only the source character needs folding.
// Case folding outside ASCII can change length (U+0130) or land on an ASCII letter (U+212A),
// so a non-ASCII character falls back to `toLowerCase` and the accepted set is unchanged.
function tryWord(p: P, word: string): boolean {
  skip(p);
  const end = p.i + word.length;
  if (end > p.src.length) return false;
  for (let k = 0; k < word.length; k += 1) {
    const code = p.src.charCodeAt(p.i + k);
    if (code > 127) {
      if (p.src.slice(p.i, end).toLowerCase() !== word) return false;
      break;
    }
    if ((code >= 65 && code <= 90 ? code + 32 : code) !== word.charCodeAt(k)) return false;
  }
  p.i = end;
  return true;
}

// Accumulated rather than parsed from a slice. A literal past `MAX_SAFE_INTEGER` is rejected rather
// than read rounded, the same domain a variable's value must stay in.
function digits(p: P): number | undefined {
  skip(p);
  if (p.src[p.i] === "@") return variable(p);
  const start = p.i;
  let value = 0;
  for (; p.i < p.src.length; p.i += 1) {
    const code = p.src.charCodeAt(p.i);
    if (code < 48 || code > 57) break;
    value = value * 10 + (code - 48);
  }
  if (value > Number.MAX_SAFE_INTEGER) fail(p, "Number too large", start);
  return p.i === start ? undefined : value;
}

// `@name` stands for its value wherever a number may stand. A name runs as far as letters, digits,
// and `_` go, so `@n d6` needs its space. Keys match whatever their case, a lowercase key winning.
function variable(p: P): number {
  const at = p.i;
  p.i += 1; // '@'
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(p.src.slice(p.i))?.[0];
  if (!name) fail(p, "Invalid variable", at);
  p.i += name.length;
  if (!p.varMap) {
    p.varMap = new Map();
    for (const [key, value] of Object.entries(p.vars ?? {})) {
      const word = key.toLowerCase();
      if (key === word || !p.varMap.has(word)) p.varMap.set(word, value);
    }
  }
  const value = p.varMap.get(name.toLowerCase());
  if (value === undefined) fail(p, `Unknown variable: @${name}`, at, "unknown-variable");
  if (!Number.isSafeInteger(value)) throw new RangeError(`vars.${name} must be a safe integer`);
  return (value as number) || 0;
}

// A count of 1 or more; zero counts are rejected (spec: Order and errors).
function uint(p: P, what: string): number {
  const at = mark(p);
  const n = digits(p);
  if (n === undefined || n < 1) fail(p, `Invalid ${what}`, at);
  return n;
}

// A signed value; the minus binds greedily, so `ko - 1` is ko(−1) (spec: Order and errors).
function int(p: P, what: string): number {
  const at = mark(p);
  let sign = 1;
  if (p.src[p.i] === "-") {
    sign = -1;
    p.i += 1;
  }
  const n = digits(p);
  if (n === undefined) fail(p, `Invalid ${what}`, at);
  // `-0` reads as 0, so no face, bound, or result carries a negative zero.
  return n === 0 ? 0 : sign * n;
}

function magnitude(p: P, value: number, at: number): number {
  if (Math.abs(value) > p.limits.value) fail(p, "Value too large", at, "limit-value");
  return value;
}

// Reject C0 controls and DEL, the same set rejected by the host application's `cleanText`.
// Quoted content is otherwise preserved exactly as written (see the EBNF grammar).
const CONTROL = /[\u0000-\u001f\u007f]/;

// Inside a string, `''` is one apostrophe.
function quoted(p: P): string {
  const open = p.i;
  p.i += 1; // opening quote, seen by the caller
  let content = "";
  for (;;) {
    const end = p.src.indexOf("'", p.i);
    if (end < 0) fail(p, "Unterminated string", open);
    content += p.src.slice(p.i, end);
    p.i = end + 1;
    if (p.src[p.i] !== "'") break;
    content += "'";
    p.i += 1;
  }
  if (CONTROL.test(content)) fail(p, "Invalid string", open);
  return content;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseFaces(p: P): DieSpec {
  skip(p);
  const ch = (p.src[p.i] ?? "").toLowerCase();
  if (/\d/.test(ch) || ch === "@") {
    const size = mark(p);
    const n = digits(p)!;
    if (n > p.limits.value) fail(p, "Invalid die size", size, "limit-value");
    if (n < 2) fail(p, "Invalid die size", size);
    return { faces: Array.from({ length: n }, (_, k) => ({ value: k + 1 })), maxValue: n };
  }
  if (ch === "f") {
    p.i += 1;
    return { faces: [{ value: -1, label: "-" }, { value: 0, label: "" }, { value: 1, label: "+" }], maxValue: 1 };
  }
  if (ch === "[") {
    const list = p.i;
    p.i += 1;
    const faces: FaceSpec[] = [];
    // Past the cap, the rest of the list is still read, so a syntax error later in it is the one
    // reported, but no more faces are kept.
    let over = false;
    skip(p);
    if (p.src[p.i] === "]") p.i += 1;
    else
      for (;;) {
        const element = parseElement(p, faces.length);
        if (element === undefined || faces.length + element.length > p.limits.faces) over = true;
        // Appended one by one: spreading a list as large as a raised cap allows overflows the stack.
        if (!over) for (const face of element!) faces.push(face);
        skip(p);
        const c = p.src[p.i];
        if (c === ",") {
          p.i += 1;
          continue;
        }
        if (c === "]") {
          p.i += 1;
          break;
        }
        fail(p, "Invalid face list");
      }
    if (over) fail(p, "Invalid face list", list, "limit-faces");
    if (faces.length < 2) fail(p, "Invalid face list", list);
    return { faces, maxValue: faces.reduce((max, face) => Math.max(max, face.value), -Infinity) };
  }
  fail(p, "Invalid die");
}

// One face-list element, expanded to the faces it spells: a range (`1..6`, `10..60:10`),
// a repeated face (`0x6`, `'hit'=1 x3`), or a single face. A range is ascending, includes
// only values up to its end, and cannot take an `x`. A range with more faces than the cap is
// returned as `undefined` rather than expanded.
function parseElement(p: P, position: number): FaceSpec[] | undefined {
  skip(p);
  if (p.src[p.i] === "'") {
    const labelAt = p.i;
    const label = quoted(p);
    skip(p);
    let assigned: number | undefined;
    if (p.src[p.i] === "=") {
      p.i += 1;
      const assignedAt = mark(p);
      assigned = magnitude(p, int(p, "face value"), assignedAt);
    }
    // Positional defaults count expanded positions: each copy is a real face (see Blocks and
    // faces). They are capped like written values, the last copy being the largest.
    const copies = repetition(p);
    if (assigned === undefined) magnitude(p, position + copies, labelAt);
    return Array.from({ length: copies }, (_, k) => ({ value: assigned ?? position + k + 1, label }));
  }
  const startAt = mark(p);
  const start = magnitude(p, int(p, "face"), startAt);
  skip(p);
  if (p.src[p.i] === "." && p.src[p.i + 1] === ".") {
    p.i += 2;
    const endAt = mark(p);
    const end = magnitude(p, int(p, "range end"), endAt);
    if (end < start) fail(p, "Descending range", endAt);
    skip(p);
    let step = 1;
    if (p.src[p.i] === ":") {
      p.i += 1;
      step = uint(p, "range step");
    }
    if (Math.floor((end - start) / step) + 1 > p.limits.faces) return undefined;
    const faces: FaceSpec[] = [];
    for (let value = start; value <= end; value += step) faces.push({ value });
    return faces;
  }
  return Array.from({ length: repetition(p) }, () => ({ value: start }));
}

// `x UINT` after a single face. Capped before allocating; the expanded list is re-checked
// against the face-list caps by the caller.
function repetition(p: P): number {
  if (!tryWord(p, "x")) return 1;
  const at = mark(p);
  const count = uint(p, "repetition count");
  if (count > p.limits.faces) fail(p, "Invalid face list", at, "limit-faces");
  return count;
}

// Palette keys match whatever their case, and a key already lowercase wins over one that folds
// to it. Only own string values count, so `#constructor` finds nothing on `Object.prototype`.
function paletteColors(p: P): Map<string, string> {
  if (p.colors) return p.colors;
  const colors = new Map<string, string>();
  for (const [key, value] of Object.entries(p.palette)) {
    const word = key.toLowerCase();
    if (typeof value === "string" && value && (key === word || !colors.has(word))) colors.set(word, value);
  }
  return (p.colors = colors);
}

function parseAppearance(p: P): Appearance {
  p.i += 1; // '{'
  const appearance: Appearance = {};
  for (;;) {
    skip(p);
    const c = p.src[p.i] ?? "";
    if (c === "'") {
      const nameAt = p.i;
      const name = quoted(p);
      if (!name) fail(p, "Invalid name", nameAt);
      if (appearance.name !== undefined) fail(p, "Duplicate name", nameAt);
      appearance.name = name;
    } else if (c === "#") {
      const colorAt = p.i;
      p.i += 1;
      const match = /^[0-9a-zA-Z]+/.exec(p.src.slice(p.i));
      if (!match) fail(p, "Invalid color", colorAt);
      p.i += match[0].length;
      const word = match[0].toLowerCase();
      const color = /^[0-9a-f]{3}$/.test(word) || /^[0-9a-f]{6}$/.test(word) ? `#${word}` : paletteColors(p).get(word);
      if (!color) fail(p, "Unknown color", colorAt, "unknown-color");
      if (appearance.color !== undefined) fail(p, "Duplicate color", colorAt);
      appearance.color = color;
      appearance.token = `#${word}`;
    } else fail(p, "Invalid appearance");
    skip(p);
    const d = p.src[p.i] ?? "";
    if (d === ",") {
      p.i += 1;
      continue;
    }
    if (d === "}") {
      p.i += 1;
      return appearance;
    }
    fail(p, "Invalid appearance");
  }
}

// A scale rides on `s` or `c` (see Final operators): `xN` multiplies the reduction, `/N` divides it
// rounding down, `/Nu` divides it rounding up. The factor is a count, capped like a face value.
function parseScale(p: P): NotationScale | undefined {
  const op = tryWord(p, "x") ? "x" : tryWord(p, "/") ? "/" : undefined;
  if (op === undefined) return undefined;
  const byAt = mark(p);
  const by = uint(p, "scale factor");
  if (by > p.limits.value) fail(p, "Value too large", byAt, "limit-value");
  if (op === "/" && tryWord(p, "u")) return { op, by, up: true };
  return { op, by };
}

function parseSuffix(p: P): {
  ops: Op[];
  filters: Filter[];
  final?: Final;
  finalAt?: number;
  scale?: NotationScale;
  scaleAt?: number;
} {
  const ops: Op[] = [];
  let hasExplode = false;
  for (;;) {
    // Marked before the glyph is consumed; the trigger analysis needs it after the parse.
    const at = mark(p);
    if (tryWord(p, "min")) {
      const boundAt = mark(p);
      ops.push({ kind: "clamp", low: true, bound: magnitude(p, int(p, "clamp bound"), boundAt), at });
      continue;
    }
    if (tryWord(p, "max")) {
      const boundAt = mark(p);
      ops.push({ kind: "clamp", low: false, bound: magnitude(p, int(p, "clamp bound"), boundAt), at });
      continue;
    }
    const glyph = tryWord(p, "!!")
      ? { horizontal: true, unbounded: false }
      : tryWord(p, "!")
        ? { horizontal: true, unbounded: true }
        : tryWord(p, "**")
          ? { horizontal: false, unbounded: false }
          : tryWord(p, "*")
            ? { horizontal: false, unbounded: true }
            : undefined;
    if (glyph) {
      if (hasExplode) fail(p, "Only one explosion operator", at);
      hasExplode = true;
      const trigger = tryWord(p, "o") ? int(p, "trigger") : undefined;
      ops.push({ kind: "explode", ...glyph, trigger, at });
      continue;
    }
    if (tryWord(p, "rru")) {
      ops.push({ kind: "rerollValue", under: true, bound: int(p, "reroll bound"), until: true, at });
      continue;
    }
    if (tryWord(p, "rro")) {
      ops.push({ kind: "rerollValue", under: false, bound: int(p, "reroll bound"), until: true, at });
      continue;
    }
    if (tryWord(p, "ru")) {
      ops.push({ kind: "rerollValue", under: true, bound: int(p, "reroll bound"), at });
      continue;
    }
    if (tryWord(p, "ro")) {
      ops.push({ kind: "rerollValue", under: false, bound: int(p, "reroll bound"), at });
      continue;
    }
    if (tryWord(p, "rl")) {
      ops.push({ kind: "rerollRank", low: true, count: uint(p, "reroll count"), at });
      continue;
    }
    if (tryWord(p, "rh")) {
      ops.push({ kind: "rerollRank", low: false, count: uint(p, "reroll count"), at });
      continue;
    }
    break;
  }
  const filters: Filter[] = [];
  for (;;) {
    const at = mark(p);
    const rank = (["kh", "kl", "km", "dh", "dl"] as const).find((mode) => tryWord(p, mode));
    if (rank) {
      skip(p);
      const digit = p.src.charCodeAt(p.i);
      const count = (digit >= 48 && digit <= 57) || digit === 64 ? uint(p, "filter count") : 1;
      filters.push({ kind: "rank", mode: rank, count, at });
      continue;
    }
    const value = tryWord(p, "ko")
      ? { keep: true, over: true }
      : tryWord(p, "ku")
        ? { keep: true, over: false }
        : tryWord(p, "do")
          ? { keep: false, over: true }
          : tryWord(p, "du")
            ? { keep: false, over: false }
            : undefined;
    if (value) {
      filters.push({ kind: "value", ...value, bound: int(p, "filter bound"), at });
      continue;
    }
    break;
  }
  const finalAt = mark(p);
  const final = tryWord(p, "s") ? "s" : tryWord(p, "c") ? "c" : tryWord(p, "i") ? "i" : undefined;
  if (final === "s" || final === "c") {
    const scaleAt = mark(p);
    const scale = parseScale(p);
    if (scale) return { ops, filters, final, finalAt, scale, scaleAt };
  }
  return final ? { ops, filters, final, finalAt } : { ops, filters };
}

function parseOperand(p: P): OperandNode {
  const ch = peek(p);
  const operandAt = p.i;
  if (ch === "(") {
    p.i += 1;
    const expr = parseExpr(p);
    skip(p);
    if (p.src[p.i] !== ")") fail(p, "Expected )");
    p.i += 1;
    skip(p);
    if (p.src[p.i] === "{") fail(p, "Appearance on a group");
    return { kind: "group", expr, ...parseSuffix(p) };
  }
  if (/\d/.test(ch) || ch === "@") {
    const n = digits(p)!;
    if (peek(p) === "d") {
      p.i += 1;
      return parseBlock(p, n, operandAt);
    }
    // Zero is a legal constant, including a +0 modifier. Only counts must be at least 1 (see Order
    // and errors), and parseBlock validates them.
    if (Math.abs(n) > p.limits.value) fail(p, "Constant too large", operandAt, "limit-value");
    skip(p);
    if (p.src[p.i] === "{") fail(p, "Appearance on a constant");
    return { kind: "const", value: n };
  }
  if (ch === "d") {
    p.i += 1;
    return parseBlock(p, 1, operandAt);
  }
  fail(p, "Invalid notation");
}

function parseBlock(p: P, count: number, at: number): BlockNode {
  if (count > p.limits.draws) fail(p, "Too many dice", at, "limit-draws");
  // A zero count is malformed, not oversized (spec: Order and errors).
  if (count < 1) fail(p, "Too many dice", at);
  const die = parseFaces(p);
  skip(p);
  const appearance = p.src[p.i] === "{" ? parseAppearance(p) : {};
  return { kind: "block", count, die, appearance, ...parseSuffix(p) };
}

function parseExpr(p: P): ExprNode {
  const operands: ExprNode["operands"] = [];
  let leading: 1 | -1 = 1;
  if (peek(p) === "-") {
    p.i += 1;
    leading = -1;
  }
  operands.push({ sign: leading, node: parseOperand(p) });
  for (;;) {
    const ch = peek(p);
    if (ch !== "+" && ch !== "-") break;
    p.i += 1;
    operands.push({ sign: ch === "-" ? -1 : 1, node: parseOperand(p) });
    if (operands.length > p.limits.operands) fail(p, "Too many operands", p.i, "limit-operands");
  }
  return { operands };
}

// The whole parse phase: length, syntax, and every static check. It draws nothing, so
// `validateDice` is exactly this function with the thrown error returned instead.
function parse(src: string, options: RollOptions, limits = resolveLimits(options.limits)): ExprNode {
  const length = effectiveLength(src);
  // No offset: no single character is at fault.
  if (length > limits.length) throw new DiceError("Invalid notation", "limit-length");
  if (!length) throw new DiceError("Invalid notation", "syntax");
  const p: P = { src, i: 0, palette: options.palette ?? DEFAULT_PALETTE, limits, vars: options.vars };
  const expr = parseExpr(p);
  skip(p);
  if (p.i < src.length) fail(p, "Invalid notation");
  validateExpr(expr, rootOperand(expr));
  // No offset: the cap is on the sum across every block.
  if (baseDice(expr) > limits.draws) throw new DiceError("Too many dice", "limit-draws");
  expr.colors = associateColors(expr);
  return expr;
}

// The lone positive operand whose final is the formula's own reduction rather than a seal.
function rootOperand(expr: ExprNode): OperandNode | undefined {
  return expr.operands.length === 1 && expr.operands[0].sign === 1 ? expr.operands[0].node : undefined;
}

// Within-roll association (spec: Appearance): an explicit color for a name applies to every
// colorless die with that name and to the name's subtotal. A die keeps its own explicit color. If a
// name has multiple explicit colors, the first one in reading order determines the subtotal color.
function associateColors(expr: ExprNode): Map<string, string> {
  const named: Appearance[] = [];
  const walk = (e: ExprNode) => {
    for (const { node } of e.operands) {
      if (node.kind === "group") walk(node.expr);
      else if (node.kind === "block" && node.appearance.name !== undefined) named.push(node.appearance);
    }
  };
  walk(expr);
  const colors = new Map<string, Appearance>();
  for (const a of named) if (a.color !== undefined && !colors.has(a.name!)) colors.set(a.name!, a);
  for (const a of named) {
    const source = colors.get(a.name!);
    if (source !== undefined && a.color === undefined) {
      a.color = source.color;
      a.token = source.token;
    }
  }
  return new Map([...colors].map(([name, a]) => [name, a.color!]));
}

// ─── Static validation (`i` placement, trigger analysis) ─────────────────────

function validateExpr(expr: ExprNode, allowI: OperandNode | undefined) {
  for (const { node } of expr.operands) {
    if (node.kind === "const") continue;
    if (node.final === "i" && node !== allowI)
      throw new DiceError("`i` must be the outermost reduction", "syntax", node.finalAt);
    let ranges = scopeRanges(node);
    for (const op of node.ops) {
      if (op.kind === "explode") validateExplode(node, op, ranges);
      if (op.kind === "rerollValue" && op.until) validateRerollUntil(node, op, ranges);
      ranges = widen(op, ranges);
    }
    if (node.kind === "group") validateExpr(node.expr, undefined);
  }
}

// A trigger is dead only when neither a face nor a raw roll an earlier operator can produce
// (`min7`, a vertical explosion) meets it. A certain trigger is judged on the faces alone: every
// chained roll is a fresh draw from the die.
function validateExplode(node: BlockNode | GroupNode, op: Op & { kind: "explode" }, ranges: RawRange[]) {
  const dice = scopeDice(node);
  const reachable =
    dice.some((die) => op.trigger === undefined || die.maxValue >= op.trigger) ||
    ranges.some((range) => range.hi >= (op.trigger ?? range.die.maxValue));
  if (!reachable) throw new DiceError("Explosion can never trigger", "dead-trigger", op.at);
  // Endless as soon as one source can reach the trigger and every face it rolls meets it again,
  // whatever the other sources in the group roll.
  const endless = (range: RawRange) => range.die.faces.every((face) => face.value >= (op.trigger ?? range.die.maxValue));
  if (op.unbounded && ranges.some((range) => acts(op, range) && endless(range)))
    throw new DiceError("Explosion would never stop", "endless-trigger", op.at);
}

// `rru`/`rro` follow the unbounded-explosion trigger rules (see Limits and safety): a threshold no
// face can meet is dead, and one every face meets can never halt.
function validateRerollUntil(node: BlockNode | GroupNode, op: Op & { kind: "rerollValue" }, ranges: RawRange[]) {
  const qualifies = (value: number) => (op.under ? value <= op.bound : value >= op.bound);
  const dice = scopeDice(node);
  const reachable =
    dice.some((die) => die.faces.some((face) => qualifies(face.value))) ||
    ranges.some((range) => qualifies(op.under ? range.lo : range.hi));
  if (!reachable) throw new DiceError("Reroll can never trigger", "dead-trigger", op.at);
  if (ranges.some((range) => acts(op, range) && range.die.faces.every((face) => qualifies(face.value))))
    throw new DiceError("Reroll would never stop", "endless-trigger", op.at);
}

// Base dice across the whole formula, groups included: the draws phase 1 is certain to make.
// Operator draws are still counted as they happen, but a formula that blows the cap before any
// operator runs (`60d6 + 60d6`) is rejected here, without rolling.
function baseDice(expr: ExprNode): number {
  let count = 0;
  for (const { node } of expr.operands) {
    if (node.kind === "block") count += node.count;
    else if (node.kind === "group") count += baseDice(node.expr);
  }
  return count;
}

// Returns the dice whose faces reach an operator's array: a block's die or the dice from a
// group's open operands. Sealed operands contribute a sourceless face instead of dice.
function scopeDice(node: BlockNode | GroupNode): DieSpec[] {
  if (node.kind === "block") return [node.die];
  return node.expr.operands.flatMap(({ node: n }) => {
    if (n.kind === "const" || n.final) return [];
    return scopeDice(n);
  });
}

// Bounds on the raw rolls one die's faces can show when they reach an operator. Over-wide is
// safe: the bounds only ever turn a dead trigger live.
interface RawRange {
  die: DieSpec;
  lo: number;
  hi: number;
}

function freshRange(die: DieSpec): RawRange {
  return { die, lo: die.faces.reduce((lo, face) => Math.min(lo, face.value), Infinity), hi: die.maxValue };
}

// The ranges reaching a node's first operator: a block's faces, or what a group's open operands
// leave after their own operators.
function scopeRanges(node: BlockNode | GroupNode): RawRange[] {
  if (node.kind === "block") return [freshRange(node.die)];
  return node.expr.operands.flatMap(({ node: n }) => {
    if (n.kind === "const" || n.final) return [];
    const ranges = n.ops.reduce((within, op) => widen(op, within), scopeRanges(n));
    return emptied(n, ranges) ? [] : ranges;
  });
}

// Whether an operand's own filters must leave it no face: rank filters by count, and on a block,
// a value filter that drops every raw roll it can see. A block's faces are unsigned until it joins,
// so its values are its raw rolls.
function emptied(node: BlockNode | GroupNode, ranges: RawRange[]): boolean {
  if (faceBound(node) === 0) return true;
  if (node.kind === "group") return false;
  return node.filters.some(
    (filter) =>
      filter.kind === "value" &&
      ranges.every((range) =>
        filter.keep
          ? filter.over
            ? range.hi < filter.bound
            : range.lo > filter.bound
          : filter.over
            ? range.lo >= filter.bound
            : range.hi <= filter.bound,
      ),
  );
}

// Whether an operator can select a face whose raw roll lies in `range`. A clamp acts on every face.
function acts(op: Op, range: RawRange): boolean {
  if (op.kind === "explode") return range.hi >= (op.trigger ?? range.die.maxValue);
  if (op.kind === "rerollValue") return op.under ? range.lo <= op.bound : range.hi >= op.bound;
  return true;
}

// The ranges after one operator. Rerolls and horizontal spawns add fresh draws; a vertical
// explosion adds fresh draws onto the seat, without bound for `*`. A range the operator cannot
// select passes through unchanged.
function widen(op: Op, ranges: RawRange[]): RawRange[] {
  if (op.kind === "clamp") {
    const to = (value: number) => (op.low ? Math.max(value, op.bound) : Math.min(value, op.bound));
    return ranges.map((range) => ({ ...range, lo: to(range.lo), hi: to(range.hi) }));
  }
  if (op.kind === "explode" && op.horizontal)
    return [...ranges, ...ranges.filter((range) => acts(op, range)).map((range) => freshRange(range.die))];
  return ranges.map((range) => {
    if (!acts(op, range)) return range;
    const fresh = freshRange(range.die);
    if (op.kind !== "explode") return { ...range, lo: Math.min(range.lo, fresh.lo), hi: Math.max(range.hi, fresh.hi) };
    if (op.unbounded)
      return { ...range, lo: fresh.lo < 0 ? -Infinity : range.lo, hi: fresh.hi > 0 ? Infinity : range.hi };
    return { ...range, lo: Math.min(range.lo, range.lo + fresh.lo), hi: Math.max(range.hi, range.hi + fresh.hi) };
  });
}

// ─── Lint ────────────────────────────────────────────────────────────────────
// Steps that can never change a roll. Every judgement rests on the over-wide `RawRange` bounds
// and on an upper bound of the faces a filter sees, so a warned step is certain to do nothing.

// The most faces an operand's array can hold after its own filters; a horizontal explosion
// leaves it unbounded.
function faceBound(node: BlockNode | GroupNode): number {
  let size =
    node.kind === "block"
      ? node.count
      : node.expr.operands.reduce((sum, { node: n }) => sum + (n.kind === "const" || n.final ? 1 : faceBound(n)), 0);
  if (node.ops.some((op) => op.kind === "explode" && op.horizontal)) size = Infinity;
  for (const filter of node.filters)
    if (filter.kind === "rank") size = filter.mode[0] === "k" ? Math.min(size, filter.count) : Math.max(size - filter.count, 0);
  return size;
}

// Whether an operator can change some raw roll that reaches it.
function canAct(op: Op, ranges: RawRange[]): boolean {
  switch (op.kind) {
    case "clamp":
      return ranges.some((range) => (op.low ? range.lo < op.bound : range.hi > op.bound));
    default:
      return ranges.some((range) => acts(op, range));
  }
}

function lintExpr(expr: ExprNode, warnings: DiceWarning[]) {
  for (const { node } of expr.operands) {
    if (node.kind === "const") continue;
    if (node.kind === "group") lintExpr(node.expr, warnings);
    let ranges = scopeRanges(node);
    for (const op of node.ops) {
      if (!canAct(op, ranges))
        warnings.push({ code: "inert-operator", message: ranges.length ? "This operator never changes a roll" : "No die here for this operator to act on", index: op.at });
      ranges = widen(op, ranges);
    }
    let size = faceBound({ ...node, filters: [] });
    for (const filter of node.filters) {
      if (filter.kind !== "rank") continue;
      const keep = filter.mode[0] === "k";
      if (filter.count >= size)
        warnings.push(
          keep
            ? { code: "inert-filter", message: "This filter always keeps every face", index: filter.at }
            : { code: "empty-filter", message: "This filter always drops every face", index: filter.at },
        );
      size = keep ? Math.min(size, filter.count) : Math.max(size - filter.count, 0);
    }
    if (node.scale?.by === 1) warnings.push({ code: "inert-scale", message: "A scale of 1 changes nothing", index: node.scaleAt! });
  }
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

// One face in the RollAtom array. `raw` is the value shown by the die, including a vertical
// seat's summed chain. Joins apply `sign`, so value = sign × raw. `die` identifies the source
// and is absent for constants and sealed faces. Filtered atoms remain in the array with
// `dropped` set and are ignored by later operators, filters, seals, and reductions.
interface Atom {
  die?: DieSpec;
  sign: 1 | -1;
  raw: number;
  history: number[];
  rerolls?: number[];
  faceIndex?: number;
  label?: string;
  name?: string;
  color?: string;
  sealed?: true;
  dropped?: true;
}

interface Ctx {
  random: RandomInt;
  limits: Readonly<Limits>;
  draws: number;
  /** Each block's base faces. Held per roll, not on the node, so one parsed tree serves many rolls. */
  base: Map<BlockNode, Atom[]>;
}

function draw(ctx: Ctx, die: DieSpec): { value: number; label?: string; index: number } {
  ctx.draws += 1;
  if (ctx.draws > ctx.limits.draws) throw new DiceError("Too many dice", "limit-draws");
  const index = ctx.random(die.faces.length);
  if (!Number.isInteger(index) || index < 1 || index > die.faces.length) throw new DiceError("Invalid roll", "invalid-roll");
  const face = die.faces[index - 1];
  return { value: face.value, label: face.label, index };
}

// Phase 1 of the determinism contract (see Limits and safety): every block's base dice,
// formula-wide, left-to-right, before any operator draws.
function rollBase(expr: ExprNode, ctx: Ctx) {
  for (const { node } of expr.operands) {
    if (node.kind === "const") continue;
    if (node.kind === "group") {
      rollBase(node.expr, ctx);
      continue;
    }
    const atoms = Array.from({ length: node.count }, () => {
      const r = draw(ctx, node.die);
      return {
        die: node.die,
        sign: 1 as const,
        raw: r.value,
        history: [r.value],
        faceIndex: r.index,
        label: r.label,
        name: node.appearance.name,
        color: node.appearance.color,
      };
    });
    ctx.base.set(node, atoms);
  }
}

// Phase 2 follows operator-token order. Operands resolve left-to-right, with child operators
// resolved before a group's postfix operators.
function resolveExpr(expr: ExprNode, ctx: Ctx): Atom[] {
  const out: Atom[] = [];
  for (const { sign, node } of expr.operands) {
    const atoms = resolveNode(node, ctx, false);
    if (sign === -1) for (const atom of atoms) atom.sign = atom.sign === 1 ? -1 : 1;
    for (const atom of atoms) out.push(atom);
  }
  return out;
}

function resolveNode(node: OperandNode, ctx: Ctx, skipFinal: boolean): Atom[] {
  if (node.kind === "const") return [{ sign: 1, raw: node.value, history: [] }];
  let atoms = node.kind === "block" ? [...ctx.base.get(node)!] : resolveExpr(node.expr, ctx);
  for (const op of node.ops) applyOp(op, atoms, ctx);
  for (const filter of node.filters) atoms = applyFilter(filter, atoms);
  if (!skipFinal && (node.final === "s" || node.final === "c")) return [seal(atoms, node.final, node.scale)];
  return atoms;
}

function applyOp(op: Op, atoms: Atom[], ctx: Ctx) {
  if (op.kind === "clamp") {
    for (const atom of atoms)
      if (atom.die && !atom.dropped) atom.raw = op.low ? Math.max(atom.raw, op.bound) : Math.min(atom.raw, op.bound);
    return;
  }
  if (op.kind === "explode") {
    // One pass over the faces present at the pass's start; an unbounded chain resolves fully
    // before the next face. Spawns inherit source, sign, and appearance.
    for (const atom of [...atoms]) {
      if (!atom.die || atom.dropped) continue;
      const trigger = op.trigger ?? atom.die.maxValue;
      if (atom.raw < trigger) continue;
      let chained = 0;
      let last: number;
      do {
        chained += 1;
        if (chained > ctx.limits.chain) throw new DiceError("Explosion limit reached", "limit-chain");
        const r = draw(ctx, atom.die);
        if (op.horizontal)
          atoms.push({
            die: atom.die,
            sign: atom.sign,
            raw: r.value,
            history: [r.value],
            faceIndex: r.index,
            label: r.label,
            name: atom.name,
            color: atom.color,
          });
        else {
          // Checked here: a count reduction never sums, so it would not catch an inexact seat.
          atom.raw = exact(atom.raw + r.value);
          atom.history.push(r.value);
        }
        last = r.value;
      } while (op.unbounded && last >= trigger);
    }
    return;
  }
  if (op.kind === "rerollValue") {
    // An `until` form keeps rerolling while the fresh roll still qualifies, resolving one
    // face's whole chain before the next face, capped like an explosion chain.
    for (const atom of atoms) {
      if (!atom.die || atom.dropped) continue;
      const qualifies = () => (op.under ? atom.raw <= op.bound : atom.raw >= op.bound);
      if (!qualifies()) continue;
      let chained = 0;
      do {
        chained += 1;
        if (chained > ctx.limits.chain) throw new DiceError("Reroll limit reached", "limit-chain");
        reroll(atom, ctx);
      } while (op.until && qualifies());
    }
    return;
  }
  // Rank reroll: order by raw roll, ties broken by array position (earlier selected first);
  // the chosen dice then draw in array order.
  const sourced = atoms.map((atom, index) => ({ atom, index })).filter((x) => x.atom.die && !x.atom.dropped);
  sourced.sort((a, b) => (op.low ? a.atom.raw - b.atom.raw : b.atom.raw - a.atom.raw) || a.index - b.index);
  const chosen = sourced.slice(0, Math.min(op.count, sourced.length)).sort((a, b) => a.index - b.index);
  for (const { atom } of chosen) reroll(atom, ctx);
}

// Replaces the whole raw roll, including a vertical seat's accumulated chain, with one fresh
// roll from the source. The sign remains unchanged, and the discarded roll is retained.
function reroll(atom: Atom, ctx: Ctx) {
  (atom.rerolls ??= []).push(atom.raw);
  const r = draw(ctx, atom.die!);
  atom.raw = r.value;
  atom.history = [r.value];
  atom.faceIndex = r.index;
  atom.label = r.label;
}

// A face's value, sign × raw. A negated zero reads as 0, never `-0`.
function signedValue(atom: Atom): number {
  return atom.sign * atom.raw || 0;
}

// Filters compare signed values; rank selection is stable, earlier faces selected first.
// A filtered-out face is marked `dropped` rather than removed, so it survives to the result
// for display; only the still-live faces are ranked, counted, or compared.
function applyFilter(filter: Filter, atoms: Atom[]): Atom[] {
  const live = atoms.map((atom, index) => ({ atom, v: signedValue(atom), index })).filter((x) => !x.atom.dropped);
  if (filter.kind === "value") {
    for (const { atom, v } of live) {
      const hit = filter.over ? v >= filter.bound : v <= filter.bound;
      if (hit !== filter.keep) atom.dropped = true;
    }
    return atoms;
  }
  const count = Math.min(filter.count, live.length);
  if (filter.mode === "km") {
    live.sort((a, b) => a.v - b.v || a.index - b.index);
    const start = Math.floor((live.length - count) / 2);
    const window = new Set(live.slice(start, start + count).map((x) => x.index));
    for (const { atom, index } of live) if (!window.has(index)) atom.dropped = true;
    return atoms;
  }
  const high = filter.mode === "kh" || filter.mode === "dh";
  live.sort((a, b) => (high ? b.v - a.v : a.v - b.v) || a.index - b.index);
  const selected = new Set(live.slice(0, count).map((x) => x.index));
  const keep = filter.mode === "kh" || filter.mode === "kl";
  for (const { atom, index } of live) if (selected.has(index) !== keep) atom.dropped = true;
  return atoms;
}

// The scale is part of the reducer (see Final operators): it multiplies or divides the reduction
// once, at the single point where a fraction can appear. Division rounds toward minus infinity by
// default (floor) and toward plus infinity with `up` (ceiling).
function applyScale(value: number, scale: NotationScale | undefined): number {
  if (!scale) return value;
  if (scale.op === "x") return exact(value * scale.by);
  // `|| 0` turns a `-0` from rounding a small negative up into 0.
  return (scale.up ? Math.ceil(value / scale.by) : Math.floor(value / scale.by)) || 0;
}

// Nested scales can exceed the integers a double holds exactly (spec: Limits and safety).
function exact(value: number): number {
  if (!Number.isSafeInteger(value)) throw new DiceError("Result too large", "result-too-large");
  return value;
}

// Each partial sum is checked: an inexact intermediate can land back in range.
function sumOf(atoms: Atom[]): number {
  return atoms.reduce((sum, atom) => exact(sum + signedValue(atom)), 0);
}

// Sealing collapses an array to one sourceless face with its unanimous appearance. Faces without a
// name or color do not prevent unanimity (spec: Combining blocks). Dropped faces contribute nothing
// and are not included outside the sealed scope.
function seal(atoms: Atom[], final: "s" | "c", scale?: NotationScale): Atom {
  const live = atoms.filter((atom) => !atom.dropped);
  const value = applyScale(final === "c" ? live.length : sumOf(live), scale);
  const names = live.map((atom) => atom.name).filter((n): n is string => n !== undefined);
  const colors = live.map((atom) => atom.color).filter((c): c is string => c !== undefined);
  return {
    sign: 1,
    raw: value,
    history: [],
    sealed: true,
    name: names.length && names.every((n) => n === names[0]) ? names[0] : undefined,
    color: colors.length && colors.every((c) => c === colors[0]) ? colors[0] : undefined,
  };
}

// A subtotal follows the formula's reduction: under `c` it counts its name's faces, otherwise it
// sums their values. A root scale is never applied to it. Its color is the name's, whichever faces
// survive, so a filter dropping the first colored face does not change it.
function buildSubtotals(
  atoms: Atom[],
  colors: Map<string, string>,
  autoColor: (label: string) => string,
  count: boolean,
): NotationSubtotal[] | undefined {
  const order: string[] = [];
  const byName = new Map<string, NotationSubtotal>();
  for (const atom of atoms) {
    if (!atom.name || atom.dropped) continue;
    const amount = count ? 1 : signedValue(atom);
    const existing = byName.get(atom.name);
    if (existing) existing.total = exact(existing.total + amount);
    else {
      order.push(atom.name);
      const color = colors.get(atom.name) ?? atom.color ?? autoColor(atom.name);
      byName.set(atom.name, { label: atom.name, total: amount, color });
    }
  }
  return order.length ? order.map((name) => byName.get(name)!) : undefined;
}

// ─── Explanation ─────────────────────────────────────────────────────────────
// Reads a node in the order `resolveNode` evaluates it: operators, filters, then the final.

const spellFace = (face: FaceSpec) =>
  face.label === undefined ? String(face.value) : `'${face.label.replaceAll("'", "''")}'=${face.value}`;

function describeDie(count: number, die: DieSpec): string {
  const { faces } = die;
  if (faces.every((face, k) => face.label === undefined && face.value === k + 1)) return `${count}d${faces.length}`;
  if (faces.map(spellFace).join() === "'-'=-1,''=0,'+'=1") return `${count}dF (Fate dice: -1, 0 or +1)`;
  const noun = count === 1 ? "die" : "dice";
  const step = faces[1].value - faces[0].value;
  const stepped = faces.every((face, k) => face.label === undefined && face.value === faces[0].value + k * step);
  if (faces.length > 3 && step > 0 && stepped) {
    const stride = step > 1 ? ` in steps of ${step}` : "";
    return `${count} ${noun} with faces ${faces[0].value} to ${faces[faces.length - 1].value}${stride}`;
  }
  const runs: string[] = [];
  for (let k = 0; k < faces.length; ) {
    const spelled = spellFace(faces[k]);
    let end = k;
    while (end < faces.length && spellFace(faces[end]) === spelled) end += 1;
    runs.push(end - k > 1 ? `${spelled} (x${end - k})` : spelled);
    k = end;
  }
  return `${count} ${noun} with faces ${runs.join(", ")}`;
}

const ranked = (count: number, which: string) => (count === 1 ? `the ${which}` : `the ${count} ${which}`);

function explainOp(op: Op, node: BlockNode | GroupNode): string {
  switch (op.kind) {
    case "clamp":
      return op.low ? `raise any roll under ${op.bound} to ${op.bound}` : `lower any roll over ${op.bound} to ${op.bound}`;
    case "explode": {
      const trigger =
        op.trigger !== undefined
          ? `${op.trigger} or more`
          : node.kind === "block"
            ? `${node.die.maxValue}, the highest face`
            : "each die's highest face";
      const effect = op.horizontal
        ? op.unbounded
          ? "each adds a new die that can explode too"
          : "each adds one new die"
        : op.unbounded
          ? "extra rolls add into the same die while they keep triggering"
          : "one extra roll adds into the same die";
      return `explode ${op.unbounded ? "" : "once "}on ${trigger} (${effect})`;
    }
    case "rerollValue": {
      const side = op.under ? "less" : "more";
      return op.until
        ? `reroll any showing ${op.bound} or ${side} until it no longer does`
        : `reroll once any showing ${op.bound} or ${side}`;
    }
    case "rerollRank":
      return `reroll ${ranked(op.count, op.low ? "lowest" : "highest")} once`;
  }
}

const RANK_WORDS = { h: "highest", l: "lowest", m: "middle" } as const;

function explainFilter(filter: Filter): string {
  if (filter.kind === "value")
    return `${filter.keep ? "keep" : "drop"} those valued ${filter.bound} or ${filter.over ? "more" : "less"}`;
  const which = RANK_WORDS[filter.mode[1] as "h" | "l" | "m"];
  return `${filter.mode[0] === "k" ? "keep" : "drop"} ${ranked(filter.count, which)}`;
}

function explainScale(scale: NotationScale | undefined): string {
  if (!scale) return "";
  return scale.op === "x" ? `, times ${scale.by}` : `, divided by ${scale.by} and rounded ${scale.up ? "up" : "down"}`;
}

function explainExpr(expr: ExprNode, indent: string, root: OperandNode | undefined): string[] {
  const lines: string[] = [];
  expr.operands.forEach(({ sign, node }, k) => {
    // A leading minus has nothing to subtract from, so the first operand is negated instead.
    const negated = k === 0 && sign === -1;
    const verb = k > 0 ? (sign === -1 ? "Subtract" : "Add") : node.kind === "const" ? "Start with" : "Roll";
    if (node.kind === "const") {
      // A constant joins by its signed value, so a negative variable reads as a subtraction.
      const value = sign * node.value || 0;
      lines.push(`${indent}${k ? `${value < 0 ? "Subtract" : "Add"} ${Math.abs(value)}` : `Start with ${value}`}.`);
      return;
    }
    const clauses = [...node.ops.map((op) => explainOp(op, node)), ...node.filters.map(explainFilter)];
    if (node.final && node !== root)
      clauses.push(`collapse to one face worth the ${node.final === "c" ? "count" : "sum"}${explainScale(node.scale)}`);
    if (negated) clauses.push("negate the result");
    if (node.kind === "group") {
      lines.push(`${indent}${verb} a group:`, ...explainExpr(node.expr, `${indent}  `, undefined));
      if (clauses.length) lines.push(`${indent}  Across the group, ${clauses.join(", then ")}.`);
      return;
    }
    const { name, token } = node.appearance;
    const appearance = [name !== undefined && `named '${name}'`, token !== undefined && `colored ${token}`].filter(Boolean);
    const die = describeDie(node.count, node.die) + (appearance.length ? ` (${appearance.join(", ")})` : "");
    lines.push(`${indent}${verb} ${die}${clauses.map((clause, n) => (n ? ", then " : ", ") + clause).join("")}.`);
  });
  return lines;
}

const anyFilter = (expr: ExprNode): boolean =>
  expr.operands.some(({ node }) => node.kind !== "const" && (node.filters.length > 0 || (node.kind === "group" && anyFilter(node.expr))));

// ─── Entry point ─────────────────────────────────────────────────────────────

// Formula length is measured with token-separating whitespace stripped; whitespace inside a
// quoted string is content and counts.
function effectiveLength(src: string): number {
  let length = 0;
  let inString = false;
  for (const ch of src) {
    if (ch === "'") {
      inString = !inString;
      length += 1;
    } else if (inString || !isSpace(ch)) length += 1;
  }
  return length;
}

/**
 * Checks a formula without rolling it, for input fields and stored macros. Runs the full parse
 * phase: syntax plus every static check `rollDice` makes, including `i` placement (see Combining
 * blocks), dead and never-halting triggers (see Limits and safety), and the length, operand, and
 * base-dice caps. No die is drawn.
 *
 * Returns the `DiceError` the same input would throw, or `null` when the formula is well-formed.
 * Only `palette`, `limits`, and `vars` are read, since the check must use the ones the roll will; passing
 * the roll's own `RollOptions` is fine. A formula that validates can still fail at roll time on a
 * limit checked during the roll: the total-draw cap once explosions and rerolls draw, the chain
 * cap on a single face, and a result past exact integer range (see Limits and safety).
 */
export function validateDice(input: string, options: RollOptions = {}): DiceError | null {
  const limits = resolveLimits(options.limits);
  try {
    parse(input, options, limits);
    return null;
  } catch (error) {
    if (error instanceof DiceError) return error;
    throw error;
  }
}

/**
 * Parses a formula once so it can be rolled many times, for a macro rolled on every turn or a
 * loop sampling the same notation. `compileDice(f, o).roll()` returns what `rollDice(f, o)`
 * returns; only the parse is shared.
 *
 * Throws the `DiceError` `validateDice` would report, here rather than at roll time. `palette`,
 * `limits`, and `vars` are read now and hold for every `roll`; `random` and `autoColor` are read now
 * too and become the defaults for every `roll`, which may override them per call.
 */
export function compileDice(input: string, options: RollOptions = {}): CompiledDice {
  const limits = resolveLimits(options.limits);
  const expr = parse(input, options, limits);
  const notation = input.trim();
  // Read once, like everything else here: editing `options` afterwards changes no roll.
  const { random, autoColor } = options;
  return {
    notation,
    roll: (rollOptions = {}) =>
      evaluate(expr, notation, limits, {
        random: rollOptions.random ?? random,
        autoColor: rollOptions.autoColor ?? autoColor,
      }),
  };
}

export function rollDice(input: string, options: RollOptions = {}): NotationResult {
  return compileDice(input, options).roll();
}

/**
 * Says in English what a formula does, one step per line in the order the roll performs them,
 * for a tooltip or a help panel. A group's steps are indented two spaces under its heading, and
 * defaults the notation leaves unwritten (`kh` keeping one, the closing sum) are spelled out.
 *
 * Throws the `DiceError` `validateDice` would report, and draws nothing. Only `palette`, `limits`,
 * and `vars` are read; a variable reads as its value. The wording is for people to read and may change in any release; never
 * parse it.
 */
export function explainDice(input: string, options: RollOptions = {}): string[] {
  const expr = parse(input, options);
  const root = rootOperand(expr);
  const final = root && root.kind !== "const" ? root.final : undefined;
  const scale = root && root.kind !== "const" ? root.scale : undefined;
  const faces = anyFilter(expr) ? "faces kept" : "faces";
  const closing =
    final === "i"
      ? `Each of the ${faces} is listed; the total is their sum.`
      : `The total is the ${final === "c" ? "number of" : "sum of the"} ${faces}${explainScale(scale)}.`;
  return [...explainExpr(expr, "", root), closing];
}

/**
 * Lists the steps of a formula that can never change a roll, for an editor that flags them: an
 * operator with nothing to act on, a filter that always keeps or always drops every face, a scale
 * of 1. A formula with warnings still rolls. Warnings come in text order; an empty array means none.
 *
 * Throws the `DiceError` `validateDice` would report, and draws nothing. Only `palette`, `limits`,
 * and `vars` are read.
 */
export function lintDice(input: string, options: RollOptions = {}): DiceWarning[] {
  const warnings: DiceWarning[] = [];
  lintExpr(parse(input, options), warnings);
  return warnings.sort((a, b) => a.index - b.index);
}

// One roll of a parsed tree. The tree is read-only here: every per-roll face lives in `ctx`.
function evaluate(expr: ExprNode, notation: string, limits: Readonly<Limits>, options: CompiledRollOptions): NotationResult {
  const ctx: Ctx = { random: options.random ?? secureRandom, limits, draws: 0, base: new Map() };
  rollBase(expr, ctx);

  // `i` and a top-level `c` must see the open array, so the root operand's final is applied
  // here as the formula's reduction rather than as a seal. A root scale rides on that
  // reduction: the faces stay open for display and `total` carries the scaled number.
  const single = rootOperand(expr);
  const rootFinal = single && single.kind !== "const" ? single.final : undefined;
  const rootScale = single && single.kind !== "const" ? single.scale : undefined;
  const atoms = single && single.kind !== "const" && rootFinal ? resolveNode(single, ctx, true) : resolveExpr(expr, ctx);

  // Reductions and flat projections use only live faces. `faces` also retains dropped faces so
  // a renderer can display the complete roll.
  const live = atoms.filter((atom) => !atom.dropped);
  const total = applyScale(rootFinal === "c" ? live.length : sumOf(live), rootScale);
  const result: NotationResult = {
    notation,
    total,
    values: live.map((atom) => signedValue(atom)),
    mode: rootFinal === "c" ? "count" : rootFinal === "i" ? "individual" : "sum",
    faces: atoms.map((atom) => {
      const face: NotationFace = { value: signedValue(atom), sign: atom.sign, raw: atom.raw, history: atom.history };
      if (atom.rerolls) face.rerolls = atom.rerolls;
      if (atom.die) face.faces = atom.die.faces.length;
      if (atom.label !== undefined) face.label = atom.label;
      if (atom.name !== undefined) face.name = atom.name;
      if (atom.color !== undefined) face.color = atom.color;
      if (atom.sealed) face.sealed = true;
      if (atom.dropped) face.dropped = true;
      return face;
    }),
  };
  if (rootScale) result.scale = { ...rootScale };
  if (rootFinal === "i" || live.some((atom) => atom.label !== undefined || atom.name !== undefined))
    result.labels = live.map((atom) => atom.label ?? atom.name ?? String(signedValue(atom)));
  const subtotals = buildSubtotals(atoms, expr.colors!, options.autoColor ?? defaultAutoColor, rootFinal === "c");
  if (subtotals) result.subtotals = subtotals;
  return result;
}
