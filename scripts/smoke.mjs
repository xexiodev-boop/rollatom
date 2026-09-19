// Packs the package, installs the tarball outside the repo, and imports it the way a consumer
// does. This catches what the suite cannot: a `files` entry left out, an `exports` map that does
// not resolve, a runtime the built module does not survive.
import { execSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "rollatom-smoke", private: true, type: "module" }, null, 2)}\n`);
  sh(`npm install "${tarball}" --no-audit --no-fund --loglevel=error`, dir);
  copyFileSync(new URL("./smoke/probe.mjs", import.meta.url), join(dir, "probe.mjs"));

  process.stdout.write(sh("node probe.mjs", dir));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
