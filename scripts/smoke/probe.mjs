// Runs inside the temp install, on the main thread and then in a worker. A worker is where the
// README's runtime claim is easiest to break: the default RNG reaches for the Web Crypto global.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

async function probe() {
  const resolved = import.meta.resolve("rollatom");
  assert.match(resolved, /node_modules\/rollatom\//, `resolved to ${resolved}, not the installed package`);

  // CommonJS callers must reach the module, not fall off the `exports` map. On a runtime without
  // `require(esm)` the right answer is ERR_REQUIRE_ESM; ERR_PACKAGE_PATH_NOT_EXPORTED never is.
  try {
    createRequire(import.meta.url)("rollatom");
  } catch (error) {
    assert.equal(error.code, "ERR_REQUIRE_ESM", `require("rollatom") failed with ${error.code}`);
  }

  // DOM globals need no check here: this file runs in Node, where they are already absent. What
  // running in Node cannot catch is the reverse — a Node-only global, or an import of any kind,
  // which browsers and web workers would reject. Both are claims the README makes.
  const source = readFileSync(new URL(resolved), "utf8");
  assert.ok(!/^\s*import\b/m.test(source) && !/\bfrom\s*["']/.test(source), "the built module imports something");
  for (const global of ["process\\.", "Buffer\\.", "__dirname", "__filename"]) {
    assert.ok(!new RegExp(`\\b${global}`).test(source), `the built module reaches for ${global.replace("\\.", "")}`);
  }

  const api = await import("rollatom");
  for (const name of ["rollDice", "validateDice", "DiceError", "DEFAULT_PALETTE", "LIMITS"]) {
    assert.ok(api[name] !== undefined, `the package does not export ${name}`);
  }
  const { rollDice, validateDice, DiceError } = api;

  assert.equal(rollDice("2d6", { random: () => 1 }).total, 2);
  assert.equal(validateDice("4d6dl1"), null);
  assert.ok(validateDice("2d6x") instanceof DiceError);

  // No `random`, so this is the Web Crypto path.
  const rolled = rollDice("2d20kh1 + 5");
  assert.ok(rolled.total >= 6 && rolled.total <= 25, `2d20kh1 + 5 gave ${rolled.total}`);
  assert.equal(rolled.faces.length, 3, "both d20s and the constant");
  assert.equal(rolled.faces.filter((face) => face.dropped).length, 1);

  return resolved;
}

if (isMainThread) {
  console.log(`main   ok  ${await probe()}`);
  const inWorker = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", resolve);
    worker.on("error", reject);
    worker.on("exit", (code) => code === 0 || reject(new Error(`worker exited with ${code}`)));
  });
  console.log(`worker ok  ${inWorker}`);
} else {
  parentPort.postMessage(await probe());
}
