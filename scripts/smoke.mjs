// Packs the package, installs the tarball outside the repo, and imports it the way a consumer
// does. This catches what the suite cannot: a `files` entry left out, an `exports` map that does
// not resolve, a runtime the built module does not survive.
//
// Arguments name the runtimes to probe, each installing with its own package manager:
// `node scripts/smoke.mjs node bun`. With none, Node alone.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = {
  node: (tarball) => `npm install "${tarball}" --no-audit --no-fund --loglevel=error`,
  bun: (tarball) => `bun add --silent "${tarball}"`,
};
const runtimes = process.argv.length > 2 ? process.argv.slice(2) : ["node"];
const unknown = runtimes.filter((runtime) => !Object.hasOwn(INSTALL, runtime));
if (unknown.length) {
  console.error(`Unknown runtime: ${unknown.join(", ")}. Known: ${Object.keys(INSTALL).join(", ")}.`);
  process.exit(1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  statSync(new URL("../dist/index.js", import.meta.url));
} catch {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "rollatom-smoke-"));
const sh = (command, cwd) => execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

try {
  const packed = sh(`npm pack --json --pack-destination "${dir}"`, root);
  const tarball = join(dir, JSON.parse(packed.slice(packed.indexOf("[")))[0].filename);

  // One install per runtime, so each resolves the package the way its own users would.
  for (const runtime of runtimes) {
    const consumer = join(dir, runtime);
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "rollatom-smoke", private: true, type: "module" }, null, 2)}\n`);
    sh(INSTALL[runtime](tarball), consumer);
    copyFileSync(new URL("./smoke/probe.mjs", import.meta.url), join(consumer, "probe.mjs"));

    for (const line of sh(`${runtime} probe.mjs`, consumer).trimEnd().split("\n")) console.log(`${runtime.padEnd(5)}${line}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
