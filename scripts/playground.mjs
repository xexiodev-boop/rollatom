// Serves the playground as `pages.yml` assembles it: the page at `/`, the built module beside it
// as `rollatom.js`. A module script does not load from `file://`, so opening the HTML directly
// cannot work. Files are read per request, so a rebuild or an edit shows on reload.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 4173);

const ROUTES = {
  "/": [new URL("../playground/index.html", import.meta.url), "text/html; charset=utf-8"],
  "/rollatom.js": [new URL("../dist/index.js", import.meta.url), "text/javascript; charset=utf-8"],
};

const server = createServer((request, response) => {
  const route = ROUTES[new URL(request.url, "http://localhost").pathname];
  if (!route) return response.writeHead(404).end();
  try {
    response.writeHead(200, { "content-type": route[1], "cache-control": "no-store" }).end(readFileSync(route[0]));
  } catch {
    response.writeHead(500).end("dist/index.js is missing. Run `npm run build` first.");
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`playground at http://127.0.0.1:${PORT}/`));
