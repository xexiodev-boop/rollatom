// RollAtom implements the dice grammar specified in `docs/GRAMMAR.md`. Each rolled face records its
// raw roll, sign, source, appearance, and chain history. `dice-notation.test.ts` contains the
// example-based specification, and `notation-contract.test.ts` checks its invariants. The
// runtime has no dependencies beyond Web Crypto; applications provide palettes and other
// integration settings through `RollOptions`.

export class DiceError extends Error {
  /** 0-based offset of the character at fault; absent for the formula-wide and roll-time caps. */
  readonly index?: number;

  constructor(message: string, index?: number) {
    super(message);
    this.name = "DiceError";
    this.index = index;
  }
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
  /** Color names behind `#name`. Defaults to `DEFAULT_PALETTE`. */
  palette?: Readonly<Record<string, string>>;
  /** Color for a named subtotal with no explicit color. Stable per label by default. */
  autoColor?: (label: string) => string;
}

const secureRandom: RandomInt = (max) => {
  if (!Number.isSafeInteger(max) || max < 1) throw new DiceError("Invalid die");
  const ceiling = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer); while (buffer[0] >= ceiling);
  return (buffer[0] % max) + 1;
};

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
 * The caps the engine enforces, exposed so an application can report them (a character
 * counter, a "too many dice" hint) without repeating the numbers. They are part of the
 * grammar's contract rather than per-call configuration, so the object is frozen: a formula
 * that rolls in one place rolls everywhere.
 */
export const LIMITS: Readonly<Limits> = Object.freeze({
  draws: 100,
  chain: 50,
  length: 200,
  operands: 20,
  faces: 100,
  value: 1000,
});

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
}

type Final = "s" | "c" | "i";

type Op =
  | { kind: "clamp"; low: boolean; bound: number; at: number }
  | { kind: "explode"; horizontal: boolean; unbounded: boolean; trigger?: number; at: number }
  | { kind: "rerollValue"; under: boolean; bound: number; until?: true; at: number }
  | { kind: "rerollRank"; low: boolean; count: number; at: number };

type Filter =
  | { kind: "rank"; mode: "kh" | "kl" | "km" | "dh" | "dl"; count: number }
  | { kind: "value"; keep: boolean; over: boolean; bound: number };

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
  atoms?: Atom[];
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
}

interface ConstNode {
  kind: "const";
  value: number;
}

type OperandNode = BlockNode | GroupNode | ConstNode;

interface ExprNode {
  operands: { sign: 1 | -1; node: OperandNode }[];
}

// ─── Scanner helpers ─────────────────────────────────────────────────────────
// Whitespace separates tokens but never splits one: `skip` runs between tokens,
// while every token's own characters are matched contiguously.

interface P {
  src: string;
  i: number;
  palette: Readonly<Record<string, string>>;
}

const SPACE = /\s/;

function skip(p: P) {
  while (p.i < p.src.length && SPACE.test(p.src[p.i])) p.i += 1;
}

function peek(p: P): string {
  skip(p);
  return (p.src[p.i] ?? "").toLowerCase();
}

// Offset where the next token starts, taken before it is consumed.
function mark(p: P): number {
  skip(p);
  return p.i;
}

// Single exit for parse failures. `at` defaults to the scanner position, the offending character;
// callers pass an earlier mark to point at the start of the rejected token instead.
function fail(p: P, message: string, at: number = p.i): never {
  throw new DiceError(message, Math.min(at, p.src.length));
}

function tryWord(p: P, word: string): boolean {
  skip(p);
  if (p.src.slice(p.i, p.i + word.length).toLowerCase() !== word) return false;
  p.i += word.length;
  return true;
}

function digits(p: P): number | undefined {
  skip(p);
  const match = /^\d+/.exec(p.src.slice(p.i));
  if (!match) return undefined;
  p.i += match[0].length;
  return Number(match[0]);
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
  return sign * n;
}

function magnitude(p: P, value: number, at: number): number {
  if (Math.abs(value) > LIMITS.value) fail(p, "Value too large", at);
  return value;
}

// Reject C0 controls and DEL, the same set rejected by the host application's `cleanText`.
// Quoted content is otherwise preserved exactly as written (see the EBNF grammar).
const CONTROL = /[\u0000-\u001f\u007f]/;

function quoted(p: P): string {
  const open = p.i;
  p.i += 1; // opening quote, seen by the caller
  const end = p.src.indexOf("'", p.i);
  if (end < 0) fail(p, "Unterminated string", open);
  const content = p.src.slice(p.i, end);
  if (CONTROL.test(content)) fail(p, "Invalid string", open);
  p.i = end + 1;
  return content;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseFaces(p: P): DieSpec {
  skip(p);
  const ch = (p.src[p.i] ?? "").toLowerCase();
  if (/\d/.test(ch)) {
    const size = mark(p);
    const n = digits(p)!;
    if (n < 2 || n > LIMITS.value) fail(p, "Invalid die size", size);
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
    skip(p);
    if (p.src[p.i] === "]") p.i += 1;
    else
      for (;;) {
        faces.push(...parseElement(p, faces.length));
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
    if (faces.length < 2 || faces.length > LIMITS.faces) fail(p, "Invalid face list", list);
    return { faces, maxValue: Math.max(...faces.map((f) => f.value)) };
  }
  fail(p, "Invalid die");
}

// One face-list element, expanded to the faces it spells: a range (`1..6`, `10..60:10`),
// a repeated face (`0x6`, `'hit'=1 x3`), or a single face. A range is ascending, includes
// only values up to its end, and cannot take an `x`.
function parseElement(p: P, position: number): FaceSpec[] {
  skip(p);
  if (p.src[p.i] === "'") {
    const label = quoted(p);
    skip(p);
    let assigned: number | undefined;
    if (p.src[p.i] === "=") {
      p.i += 1;
      const assignedAt = mark(p);
      assigned = magnitude(p, int(p, "face value"), assignedAt);
    }
    // Positional defaults count expanded positions: each copy is a real face (see Blocks and
    // faces).
    return Array.from({ length: repetition(p) }, (_, k) => ({ value: assigned ?? position + k + 1, label }));
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
  if (count > LIMITS.faces) fail(p, "Invalid face list", at);
  return count;
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
      const color = /^[0-9a-f]{3}$/.test(word) || /^[0-9a-f]{6}$/.test(word) ? `#${word}` : p.palette[word];
      if (!color) fail(p, "Unknown color", colorAt);
      if (appearance.color !== undefined) fail(p, "Duplicate color", colorAt);
      appearance.color = color;
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
  if (by > LIMITS.value) fail(p, "Value too large", byAt);
  if (op === "/" && tryWord(p, "u")) return { op, by, up: true };
  return { op, by };
}

function parseSuffix(p: P): {
  ops: Op[];
  filters: Filter[];
  final?: Final;
  finalAt?: number;
  scale?: NotationScale;
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
    const rank = (["kh", "kl", "km", "dh", "dl"] as const).find((mode) => tryWord(p, mode));
    if (rank) {
      skip(p);
      const count = /\d/.test(p.src[p.i] ?? "") ? uint(p, "filter count") : 1;
      filters.push({ kind: "rank", mode: rank, count });
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
      filters.push({ kind: "value", ...value, bound: int(p, "filter bound") });
      continue;
    }
    break;
  }
  const finalAt = mark(p);
  const final = tryWord(p, "s") ? "s" : tryWord(p, "c") ? "c" : tryWord(p, "i") ? "i" : undefined;
  if (final === "s" || final === "c") {
    const scale = parseScale(p);
    if (scale) return { ops, filters, final, finalAt, scale };
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
  if (/\d/.test(ch)) {
    const n = digits(p)!;
    if (peek(p) === "d") {
      p.i += 1;
      return parseBlock(p, n, operandAt);
    }
    // Zero is a legal constant, including a +0 modifier. Only counts must be at least 1 (see Order
    // and errors), and parseBlock validates them.
    if (n > LIMITS.value) fail(p, "Constant too large", operandAt);
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
  if (count < 1 || count > LIMITS.draws) fail(p, "Too many dice", at);
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
    if (operands.length > LIMITS.operands) fail(p, "Too many operands");
  }
  return { operands };
}

// The whole parse phase: length, syntax, and every static check. It draws nothing, so
// `validateDice` is exactly this function with the thrown error returned instead.
function parse(src: string, palette: Readonly<Record<string, string>>): ExprNode {
  const length = effectiveLength(src);
  // No offset: no single character is at fault.
  if (!length || length > LIMITS.length) throw new DiceError("Invalid notation");
  const p: P = { src, i: 0, palette };
  const expr = parseExpr(p);
  skip(p);
  if (p.i < src.length) fail(p, "Invalid notation");
  const rootNode = expr.operands.length === 1 && expr.operands[0].sign === 1 ? expr.operands[0].node : undefined;
  validateExpr(expr, rootNode);
  // No offset: the cap is on the sum across every block.
  if (baseDice(expr) > LIMITS.draws) throw new DiceError("Too many dice");
  associateColors(expr);
  return expr;
}

// Within-roll association (spec: Appearance): an explicit color for a name applies to every
// colorless die with that name and to the name's subtotal. A die keeps its own explicit color. If a
// name has multiple explicit colors, the first one in reading order determines the subtotal color.
function associateColors(expr: ExprNode) {
  const named: Appearance[] = [];
  const walk = (e: ExprNode) => {
    for (const { node } of e.operands) {
      if (node.kind === "group") walk(node.expr);
      else if (node.kind === "block" && node.appearance.name !== undefined) named.push(node.appearance);
    }
  };
  walk(expr);
  const colors = new Map<string, string>();
  for (const a of named) if (a.color !== undefined && !colors.has(a.name!)) colors.set(a.name!, a.color);
  for (const a of named) {
    const color = colors.get(a.name!);
    if (color !== undefined && a.color === undefined) a.color = color;
  }
}

// ─── Static validation (`i` placement, trigger analysis) ─────────────────────

function validateExpr(expr: ExprNode, allowI: OperandNode | undefined) {
  for (const { node } of expr.operands) {
    if (node.kind === "const") continue;
    if (node.final === "i" && node !== allowI)
      throw new DiceError("`i` must be the outermost reduction", node.finalAt);
    for (const op of node.ops) {
      if (op.kind === "explode") validateExplode(node, op);
      if (op.kind === "rerollValue" && op.until) validateRerollUntil(node, op);
    }
    if (node.kind === "group") validateExpr(node.expr, undefined);
  }
}

function validateExplode(node: BlockNode | GroupNode, op: Op & { kind: "explode" }) {
  const dice = scopeDice(node);
  const reachable = dice.some((die) => op.trigger === undefined || die.maxValue >= op.trigger);
  if (!reachable) throw new DiceError("Explosion can never trigger", op.at);
  if (op.unbounded) {
    const certain = dice.length > 0 && dice.every((die) => die.faces.every((face) => face.value >= (op.trigger ?? die.maxValue)));
    if (certain) throw new DiceError("Explosion would never stop", op.at);
  }
}

// `rru`/`rro` follow the unbounded-explosion trigger rules (see Limits and safety): a threshold no
// face can meet is dead, and one every face meets can never halt.
function validateRerollUntil(node: BlockNode | GroupNode, op: Op & { kind: "rerollValue" }) {
  const qualifies = (value: number) => (op.under ? value <= op.bound : value >= op.bound);
  const dice = scopeDice(node);
  const reachable = dice.some((die) => die.faces.some((face) => qualifies(face.value)));
  if (!reachable) throw new DiceError("Reroll can never trigger", op.at);
  const certain = dice.length > 0 && dice.every((die) => die.faces.every((face) => qualifies(face.value)));
  if (certain) throw new DiceError("Reroll would never stop", op.at);
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
  draws: number;
}

function draw(ctx: Ctx, die: DieSpec): { value: number; label?: string; index: number } {
  ctx.draws += 1;
  if (ctx.draws > LIMITS.draws) throw new DiceError("Too many dice");
  const index = ctx.random(die.faces.length);
  if (!Number.isInteger(index) || index < 1 || index > die.faces.length) throw new DiceError("Invalid roll");
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
    node.atoms = Array.from({ length: node.count }, () => {
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
  }
}

// Phase 2 follows operator-token order. Operands resolve left-to-right, with child operators
// resolved before a group's postfix operators.
function resolveExpr(expr: ExprNode, ctx: Ctx): Atom[] {
  const out: Atom[] = [];
  for (const { sign, node } of expr.operands) {
    const atoms = resolveNode(node, ctx, false);
    if (sign === -1) for (const atom of atoms) atom.sign = atom.sign === 1 ? -1 : 1;
    out.push(...atoms);
  }
  return out;
}

function resolveNode(node: OperandNode, ctx: Ctx, skipFinal: boolean): Atom[] {
  if (node.kind === "const") return [{ sign: 1, raw: node.value, history: [] }];
  let atoms = node.kind === "block" ? [...node.atoms!] : resolveExpr(node.expr, ctx);
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
        if (chained > LIMITS.chain) throw new DiceError("Explosion limit reached");
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
          atom.raw += r.value;
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
        if (chained > LIMITS.chain) throw new DiceError("Reroll limit reached");
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

// Filters compare signed values; rank selection is stable, earlier faces selected first.
// A filtered-out face is marked `dropped` rather than removed, so it survives to the result
// for display; only the still-live faces are ranked, counted, or compared.
function applyFilter(filter: Filter, atoms: Atom[]): Atom[] {
  const live = atoms.map((atom, index) => ({ atom, v: atom.sign * atom.raw, index })).filter((x) => !x.atom.dropped);
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
  if (scale.op === "x") return value * scale.by;
  return scale.up ? Math.ceil(value / scale.by) : Math.floor(value / scale.by);
}

// Sealing collapses an array to one sourceless face with its unanimous appearance. Faces without a
// name or color do not prevent unanimity (spec: Combining blocks). Dropped faces contribute nothing
// and are not included outside the sealed scope.
function seal(atoms: Atom[], final: "s" | "c", scale?: NotationScale): Atom {
  const live = atoms.filter((atom) => !atom.dropped);
  const value = applyScale(final === "c" ? live.length : live.reduce((sum, atom) => sum + atom.sign * atom.raw, 0), scale);
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

function buildSubtotals(atoms: Atom[], autoColor: (label: string) => string): NotationSubtotal[] | undefined {
  const order: string[] = [];
  const byName = new Map<string, NotationSubtotal>();
  for (const atom of atoms) {
    if (!atom.name || atom.dropped) continue;
    const existing = byName.get(atom.name);
    if (existing) existing.total += atom.sign * atom.raw;
    else {
      order.push(atom.name);
      byName.set(atom.name, { label: atom.name, total: atom.sign * atom.raw, color: atom.color ?? autoColor(atom.name) });
    }
  }
  return order.length ? order.map((name) => byName.get(name)!) : undefined;
}

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
    } else if (inString || !SPACE.test(ch)) length += 1;
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
 * Only `palette` is read, since `#name` tokens must resolve against the palette the roll will
 * use; passing the roll's own `RollOptions` is fine. A formula that validates can still fail at
 * roll time on a limit only the dice decide: the total-draw cap once explosions and rerolls
 * draw, and the 50-roll chain cap on a single face (see Limits and safety).
 */
export function validateDice(input: string, options: RollOptions = {}): DiceError | null {
  try {
    parse(input, options.palette ?? DEFAULT_PALETTE);
    return null;
  } catch (error) {
    if (error instanceof DiceError) return error;
    throw error;
  }
}

export function rollDice(input: string, options: RollOptions = {}): NotationResult {
  const expr = parse(input, options.palette ?? DEFAULT_PALETTE);
  const ctx: Ctx = { random: options.random ?? secureRandom, draws: 0 };
  rollBase(expr, ctx);

  // `i` and a top-level `c` must see the open array, so the root operand's final is applied
  // here as the formula's reduction rather than as a seal. A root scale rides on that
  // reduction: the faces stay open for display and `total` carries the scaled number.
  const single = expr.operands.length === 1 && expr.operands[0].sign === 1 ? expr.operands[0].node : undefined;
  const rootFinal = single && single.kind !== "const" ? single.final : undefined;
  const rootScale = single && single.kind !== "const" ? single.scale : undefined;
  const atoms = single && single.kind !== "const" && rootFinal ? resolveNode(single, ctx, true) : resolveExpr(expr, ctx);

  // Reductions and flat projections use only live faces. `faces` also retains dropped faces so
  // a renderer can display the complete roll.
  const live = atoms.filter((atom) => !atom.dropped);
  const total = applyScale(rootFinal === "c" ? live.length : live.reduce((sum, atom) => sum + atom.sign * atom.raw, 0), rootScale);
  const result: NotationResult = {
    notation: input.trim(),
    total,
    values: live.map((atom) => atom.sign * atom.raw),
    mode: rootFinal === "c" ? "count" : rootFinal === "i" ? "individual" : "sum",
    faces: atoms.map((atom) => {
      const face: NotationFace = { value: atom.sign * atom.raw, sign: atom.sign, raw: atom.raw, history: atom.history };
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
    result.labels = live.map((atom) => atom.label ?? atom.name ?? String(atom.sign * atom.raw));
  const subtotals = buildSubtotals(atoms, options.autoColor ?? defaultAutoColor);
  if (subtotals) result.subtotals = subtotals;
  return result;
}
