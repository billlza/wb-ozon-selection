import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("GET /api/stores only projects the registry and the loaded bindings", async () => {
  const server = await readFile(path.join(appDir, "server.mjs"), "utf8");
  const start = server.indexOf('if (req.method === "GET" && pathname === "/api/stores")');
  assert.ok(start >= 0, "server must expose GET /api/stores");
  const route = server.slice(start, server.indexOf("\n  }\n", start));
  assert.match(route, /listStores\(\{ storeBindings: runtimeConfiguration\.storeBindings \}\)/);
  for (const forbidden of ["readData(", "mutateData(", "requestBody(", "fetch("]) {
    assert.equal(route.includes(forbidden), false, `read-only route must not call ${forbidden}`);
  }
});
