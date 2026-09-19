// Measures the module npm serves and a CDN sends, and fails past a budget so the figures the
// README quotes cannot rot unnoticed. Raising a budget is meant to be a deliberate edit.
import { readFileSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";

const BUDGET = { raw: 40 * 1024, gzip: 11 * 1024 };

const FILE = new URL("../dist/index.js", import.meta.url);
try {
  statSync(FILE);
} catch {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const bytes = readFileSync(FILE);
const measured = {
  raw: bytes.length,
  gzip: gzipSync(bytes, { level: 9 }).length,
  brotli: brotliCompressSync(bytes).length,
};

const kB = (n) => `${(n / 1024).toFixed(1)} kB`;
for (const [name, size] of Object.entries(measured)) {
  const budget = BUDGET[name];
  console.log(`${name.padEnd(6)} ${kB(size).padStart(8)}${budget ? `  budget ${kB(budget)}` : ""}`);
}

const over = Object.entries(BUDGET).filter(([name, budget]) => measured[name] > budget);
for (const [name, budget] of over) {
  console.error(`::error::dist/index.js ${name} is ${kB(measured[name])}, over the ${kB(budget)} budget.`);
}
process.exit(over.length ? 1 : 0);
