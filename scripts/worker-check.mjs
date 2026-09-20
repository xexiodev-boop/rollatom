// Runs the built module in a real browser's module worker. `smoke.mjs` proves the module touches
// no DOM global and imports nothing; only a browser engine proves the file parses and runs in one.
// Needs a browser: `npx playwright install chromium`.
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";

const DIST = new URL("../dist/index.js", import.meta.url);
try {
  statSync(DIST);
} catch {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const WORKER = `
  import { rollDice, compileDice, validateDice } from "./rollatom.js";
  const compiled = compileDice("2d6");
  postMessage({
    seeded: rollDice("2d6", { random: () => 1 }).total,
    total: rollDice("2d20kh1 + 5").total,
    faces: rollDice("2d20kh1 + 5").faces.length,
    index: validateDice("2d6x").index,
    code: validateDice("101d6").code,
    reused: [1, 6, 1].map((face) => compiled.roll({ random: () => face }).total).join(),
  });
`;

// A module worker needs a real origin, so the page is served rather than set on about:blank.
const PAGE = `<!doctype html><meta charset="utf-8"><title>worker check</title>
  <script type="module">
    globalThis.rolled = new Promise((resolve, reject) => {
      const worker = new Worker("./worker.mjs", { type: "module" });
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message ?? "worker failed to load"));
    });
  </script>`;

const ROUTES = {
  "/": [PAGE, "text/html"],
  "/worker.mjs": [WORKER, "text/javascript"],
  "/rollatom.js": [readFileSync(DIST, "utf8"), "text/javascript"],
};

const server = createServer((request, response) => {
  const route = ROUTES[request.url];
  if (!route) return response.writeHead(404).end();
  response.writeHead(200, { "content-type": route[1] }).end(route[0]);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const browser = await chromium.launch();
const failures = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => message.type() === "error" && failures.push(`console: ${message.text()}`));

  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  let rolled;
  try {
    rolled = await page.evaluate(() => globalThis.rolled);
  } catch (error) {
    // A module worker that fails to load reports little; the page and console listeners say more.
    failures.push(`the worker never answered: ${error.message.split("\n")[0]}`);
  }

  if (rolled) {
    const expected = { seeded: 2, faces: 3, index: 3, code: "limit-draws", reused: "2,12,2" };
    for (const [key, value] of Object.entries(expected)) {
      if (rolled[key] !== value) failures.push(`${key} was ${rolled[key]}, expected ${value}`);
    }
    if (!(rolled.total >= 6 && rolled.total <= 25)) failures.push(`total was ${rolled.total}`);
  }

  console.log(`chromium worker ${failures.length ? "FAILED" : "ok"}  ${JSON.stringify(rolled ?? null)}`);
} finally {
  await browser.close();
  server.close();
}

for (const failure of failures) console.error(`::error::${failure}`);
process.exit(failures.length ? 1 : 0);
