import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("GET /api/candidates/:id/wb-rough-profit reads one saved candidate and writes nothing", async () => {
  const server = await readFile(path.join(appDir, "server.mjs"), "utf8");
  const start = server.indexOf('if (req.method === "GET" && wbRoughProfitRoute)');
  assert.ok(start >= 0, "server must expose GET /api/candidates/:id/wb-rough-profit");
  const route = server.slice(start, server.indexOf("\n  }\n", start));
  assert.match(route, /wbRoughProfitForCandidate\(\{ document: snapshot, candidate/);
  assert.match(route, /readers: \{ commission: \(input\) => readWbCommissionReference\(input\), tariff: \(input\) => readCelWbTariffCatalog\(input\) \}/);
  assert.match(route, /resolveExchangeRate: supplierDraftEstimateInputs\.resolveExchangeRate/, "汇率和 Ozon 粗算共用一个读取");
  for (const forbidden of ["mutateData(", "mutateDataWhenChanged(", "requestBody(", "readJsonRequestBody(", "fetch("]) {
    assert.equal(route.includes(forbidden), false, `read-only route must not call ${forbidden}`);
  }
});
