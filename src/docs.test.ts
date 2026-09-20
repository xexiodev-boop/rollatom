import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileDice, DiceError, explainDice, rollDice, validateDice } from "./index";

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

// Excluded: the Roll20/Foundry table quotes other rollers' spellings (`3d6x`, `6d6>5`) and the
// error-code table quotes formulas written to be rejected, both invalid here by design; a token
// carrying an ellipsis is a placeholder (`d[…]`). The error-code table has its own check below.
const REJECTED_NOTATION_SECTIONS = new Set(["Coming from Roll20 or Foundry", "Error codes"]);

const tableFormulas = (markdown: string): string[] => {
  const formulas = new Set<string>();
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (!line.startsWith("|") || REJECTED_NOTATION_SECTIONS.has(section)) continue;
    for (const cell of line.matchAll(/`([^`]+)`/g)) {
      const token = cell[1]!;
      if (DIE.test(token) && !token.includes("…")) formulas.add(token);
    }
  }
  return [...formulas];
};

// Rows of the README's error-code table: `| `code` | prose | `formula` |`. The header and the
// separator carry no backticked code, and a row whose example is `--` carries no formula.
const codeRows = (markdown: string): { code: string; formula: string }[] => {
  const rows: { code: string; formula: string }[] = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (section !== "Error codes" || !line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const code = /^`([a-z-]+)`$/.exec(cells[1] ?? "")?.[1];
    const formula = /^`(.+)`$/.exec(cells[3] ?? "")?.[1];
    if (code && formula) rows.push({ code, formula });
  }
  return rows;
};

interface DocCall {
  fn: "rollDice" | "validateDice" | "compileDice";
  formula: string;
  /** The trailing `// …` comment, which for `validateDice` states the expected outcome. */
  comment: string | undefined;
}

const fencedCalls = (markdown: string): DocCall[] => {
  const calls: DocCall[] = [];
  for (const match of markdown.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)) {
    for (const line of match[1]!.split("\n")) {
      // Only calls whose sole argument is the formula: one passing `options` may depend on a
      // custom palette (see README "Colors"), which this file cannot reconstruct from the page.
      const call = /(?:^|=\s*)(rollDice|validateDice|compileDice)\((["'])(.+?)\2\s*\)/.exec(line);
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

// An `explainDice("…");` line followed by its output, one `// ` comment per returned line.
const explanations = (markdown: string): { formula: string; lines: string[] }[] => {
  const found: { formula: string; lines: string[] }[] = [];
  for (const match of markdown.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)) {
    const source = match[1]!.split("\n").map((line) => line.replace(/^ {2}/, ""));
    source.forEach((line, at) => {
      const call = /^explainDice\((["'])(.+?)\1\);$/.exec(line);
      if (!call) return;
      const lines: string[] = [];
      for (let k = at + 1; source[k]?.startsWith("// "); k += 1) lines.push(source[k]!.slice(3));
      found.push({ formula: call[2]!, lines });
    });
  }
  return found;
};

const rollFailures =(formulas: string[]): string[] =>
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
    expect(readme.calls.filter((call) => call.fn === "compileDice").length).toBeGreaterThanOrEqual(2);
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

      // A compiled example either states the error it throws or is expected to compile and roll.
      const compiles = calls.filter((call) => call.fn === "compileDice");
      it.skipIf(compiles.length === 0)("every compileDice example behaves as documented", () => {
        const actual = compiles.map(({ formula }) => {
          try {
            compileDice(formula).roll({ random: seeded() });
            return "rolled";
          } catch (error) {
            return `DiceError: ${(error as Error).message}`;
          }
        });

        expect(actual).toEqual(
          compiles.map(({ comment }) => /DiceError:\s*(.+?)(?:\s*\(.*\))?$/.exec(comment ?? "")?.[0] ?? "rolled"),
        );
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

  it("every explainDice example shows the lines it returns", () => {
    const examples = [...explanations(read("README.md")), ...explanations(read("CHANGELOG.md"))];
    expect(examples.length).toBeGreaterThanOrEqual(4);

    expect(examples.map(({ formula }) => explainDice(formula))).toEqual(examples.map(({ lines }) => lines));
  });

  // The page's `["formula", "blurb"]` guide rows, the `ours:` column of its translation table,
  // and the `data-notation` of its preset buttons.
  it("every formula the playground offers is valid notation and rolls", () => {
    const page = read("playground/index.html");
    const formulas = [
      ...[...page.matchAll(/^\s*\["((?:[^"\\]|\\.)+)", "/gm)].map((match) => match[1]!),
      ...[...page.matchAll(/ours: "([^"]+)"/g)].map((match) => match[1]!),
      ...[...page.matchAll(/data-notation="([^"]+)"/g)].map((match) => match[1]!),
    ];
    expect(formulas.length).toBeGreaterThanOrEqual(35);

    expect(formulas.filter((formula) => validateDice(formula) !== null)).toEqual([]);
    expect(rollFailures(formulas)).toEqual([]);
  });

  it("every example in the error-code table produces the code it is listed under", () => {
    const rows = codeRows(read("README.md"));
    expect(rows.length).toBeGreaterThanOrEqual(9); // just under the examples the table carries

    // Always the highest face: what drives an explosion chain to its cap.
    const actual = rows.map(({ formula }) => {
      const rejected = validateDice(formula);
      if (rejected) return rejected.code;
      try {
        rollDice(formula, { random: (faceCount) => faceCount });
        return "rolled";
      } catch (error) {
        return (error as DiceError).code;
      }
    });

    expect(actual).toEqual(rows.map((row) => row.code));
  });

  it("the error type the documentation tells callers to branch on is the one thrown", () => {
    // README "Calling the engine" instructs `instanceof DiceError`, never message matching.
    expect(() => rollDice("6d6kh3!")).toThrow(DiceError);
    expect(validateDice("6d6kh3!")).toBeInstanceOf(DiceError);
  });
});
