import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DiceError, rollDice, validateDice } from "./index";

// ─────────────────────────────────────────────────────────────────────────────
// Documentation contract. `README.md` and `docs/GRAMMAR.md` state engine behavior as formula cells
// in tables and `rollDice`/`validateDice` calls in fenced examples. Neither is generated from the
// engine, so both can drift; this file makes drift a failing test.
// ─────────────────────────────────────────────────────────────────────────────

const DOCS = ["README.md", "docs/GRAMMAR.md"] as const;

// Normalised to LF: a CRLF working tree stops the fence pattern from matching.
const read = (relative: string) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

// Fixed stream: under the real CSPRNG an unlucky run could drive an explosion into the chain cap.
const seeded = () => {
  let state = 0x2f6e2b1;
  return (faceCount: number) => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return ((state >>> 16) % faceCount) + 1;
  };
};

// A backticked token is a formula when it contains a die (`4d6`, `dF`, `d[3..6]`), which excludes
// the operator spellings (`khN`, `!!`) and result field names (`total`, `raw`) in the same columns.
const DIE = /\d*d(\d|\[|F)/;

// Excluded: the Roll20/Foundry table quotes other rollers' spellings (`3d6x`, `6d6>5`), invalid
// here by design, and a token carrying an ellipsis is a placeholder (`d[…]`).
const FOREIGN_NOTATION_SECTIONS = new Set(["Coming from Roll20 or Foundry"]);

const tableFormulas = (markdown: string): string[] => {
  const formulas = new Set<string>();
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (!line.startsWith("|") || FOREIGN_NOTATION_SECTIONS.has(section)) continue;
    for (const cell of line.matchAll(/`([^`]+)`/g)) {
      const token = cell[1]!;
      if (DIE.test(token) && !token.includes("…")) formulas.add(token);
    }
  }
  return [...formulas];
};

interface DocCall {
  fn: "rollDice" | "validateDice";
  formula: string;
  /** The trailing `// …` comment, which for `validateDice` states the expected outcome. */
  comment: string | undefined;
}

const fencedCalls = (markdown: string): DocCall[] => {
  const calls: DocCall[] = [];
  for (const match of markdown.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)) {
    for (const line of match[1]!.split("\n")) {
      const call = /^\s*(rollDice|validateDice)\((["'])(.+?)\2\s*[,)]/.exec(line);
      if (!call) continue;
      calls.push({
        fn: call[1] as DocCall["fn"],
        formula: call[3]!,
        comment: /\/\/\s*(.*)$/.exec(line)?.[1]?.trim(),
      });
    }
  }
  return calls;
};

const rollFailures = (formulas: string[]): string[] =>
  formulas.flatMap((formula) => {
    try {
      rollDice(formula, { random: seeded() });
      return [];
    } catch (error) {
      return [`${formula} -> ${(error as Error).message}`];
    }
  });

const docs = DOCS.map((name) => {
  const markdown = read(name);
  return { name, formulas: tableFormulas(markdown), calls: fencedCalls(markdown) };
});

describe("documentation contract", () => {
  // Without this, a reformatted table would empty the extractors and every test below would pass
  // over nothing. The floors sit just under the current counts.
  it("extracts enough from each document to be testing anything", () => {
    const readme = docs.find((d) => d.name === "README.md")!;
    const grammar = docs.find((d) => d.name === "docs/GRAMMAR.md")!;

    expect(readme.calls.length).toBeGreaterThanOrEqual(12);
    expect(readme.formulas.length).toBeGreaterThanOrEqual(18);
    expect(grammar.formulas.length).toBeGreaterThanOrEqual(40);
  });

  for (const { name, formulas, calls } of docs) {
    describe(name, () => {
      it.skipIf(formulas.length === 0)("every formula in a table is valid notation", () => {
        const rejected = formulas
          .filter((formula) => validateDice(formula) !== null)
          .map((formula) => `${formula} -> ${validateDice(formula)!.message}`);

        expect(rejected).toEqual([]);
      });

      it.skipIf(formulas.length === 0)("every formula in a table also rolls", () => {
        expect(rollFailures(formulas)).toEqual([]);
      });

      const rolls = calls.filter((call) => call.fn === "rollDice");
      it.skipIf(rolls.length === 0)("every rollDice example rolls", () => {
        expect(rollFailures(rolls.map((call) => call.formula))).toEqual([]);
      });

      // The comment states the outcome: `// null`, or `// DiceError: <message>` plus an optional
      // parenthetical the engine does not throw.
      const validations = calls.filter((c) => c.fn === "validateDice" && c.comment !== undefined);
      it.skipIf(validations.length === 0)("every validateDice example states its real outcome", () => {
        const documented = validations.map(({ formula, comment }) => {
          const thrown = /^DiceError:\s*(.+?)(?:\s*\(.*\))?$/.exec(comment!);
          return { formula, expected: thrown ? thrown[1] : comment };
        });
        const actual = documented.map(({ formula }) => validateDice(formula)?.message ?? "null");

        expect(actual).toEqual(documented.map((entry) => entry.expected));
      });
    });
  }

  it("the error type the documentation tells callers to branch on is the one thrown", () => {
    // README "Calling the engine" instructs `instanceof DiceError`, never message matching.
    expect(() => rollDice("6d6kh3!")).toThrow(DiceError);
    expect(validateDice("6d6kh3!")).toBeInstanceOf(DiceError);
  });
});
