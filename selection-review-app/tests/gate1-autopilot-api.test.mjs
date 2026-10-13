import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { stopApiProcess } from "./helpers/api-process-lifecycle.mjs";
import { createSavedLocalPreparationCandidate } from "./fixtures/c1-local-draft-source-fixture.mjs";
import { buildGate1AutopilotGrant } from "../lib/gate1-autopilot.mjs";
import { buildGate1RightsDeclaration } from "../lib/gate1-rights-declaration.mjs";
import { createFormalC1DraftFixture } from "./fixtures/formal-c1-flow-fixture.mjs";

// 「做这件」之后不花钱的几步由软件自己往下走。合成商品、合成文案网关；网关被叫到一次就是错。
const appDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.SELECTION_REVIEW_TEST_PORT);
const gatewayPort = Number(process.env.SELECTION_REVIEW_TEST_GATEWAY_PORT);
if (![port, gatewayPort].every(value => Number.isSafeInteger(value) && value > 0 && ![4317, 4318, 4173].includes(value)) || port === gatewayPort) {
  throw new Error("TEST_REQUIRES_ISOLATED_PORT");
}
const base = `http://127.0.0.1:${port}`;
const password = "synthetic gate1 autopilot test password";

function accepted(candidate, { grant }) {
  candidate.gate1DecisionV1 = { schemaVersion: "gate1-decision-v1", decision: "accept", decidedAt: "2026-10-11T09:00:00.000Z",
    decidedBy: "synthetic-owner", sourceRevision: 1, roundIndex: 0 };
  if (grant) candidate.gate1AutopilotGrantV1 = structuredClone(buildGate1AutopilotGrant({ candidateId: candidate.id, sourceRevision: 1,
    decision: candidate.gate1DecisionV1, via: "gate1_accept", grantedAt: "2026-10-11T09:00:00.000Z", grantedBy: "synthetic-owner" }));
  return candidate;
}

test("做这件之后：有许可的商品软件自己做到付费那一步停下；没许可的等主人点一下；出错记下来不自己重试", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "gate1-autopilot-api-"));
  await mkdir(path.join(directory, "private"), { mode: 0o700 });
  await mkdir(path.join(directory, "business"));
  const dataFile = path.join(directory, "business/state.json");
  const readDocument = async () => JSON.parse(await readFile(dataFile, "utf8"));
  let providerCalls = 0;
  const gateway = createServer((req, res) => { providerCalls += 1; res.writeHead(500); res.end("{}"); });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(gatewayPort, "127.0.0.1", resolve); });
  let child = null, cookie = "";
  const stderr = [];
  t.after(async () => {
    try { if (child) await stopApiProcess(child); }
    finally {
      gateway.closeAllConnections();
      await new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function start(candidate) {
    if (child) { await stopApiProcess(child); child = null; }
    await writeFile(dataFile, JSON.stringify({ meta: { version: 2, automationStarted: false }, rules: {}, candidates: [candidate],
      evidencePacks: [], dispatches: [], runtime: { softwareJobs: [], softwareJobAuthorizationRecords: [], softwareJobCredentialBindings: [] } }));
    child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], { cwd: appDir,
      env: { ...process.env, SELECTION_REVIEW_API_PORT: String(port), SELECTION_REVIEW_DATA_FILE: dataFile,
        SELECTION_REVIEW_PUBLIC_ORIGIN: base, SELECTION_REVIEW_ALLOWED_ORIGINS: base,
        SELECTION_REVIEW_IDENTITY_PROVIDER: "local_owner_password", SELECTION_REVIEW_OWNER_IDENTITY_FILE: path.join(directory, "private/owner.json"),
        SELECTION_REVIEW_C2_UPLOAD_DIR: path.join(directory, "uploads"),
        SELECTION_REVIEW_STORE_BINDINGS_JSON: JSON.stringify([{ targetStore: candidate.targetStore, platform: candidate.targetPlatform, storeRef: candidate.storeRef }]),
        SELECTION_REVIEW_PRODUCTION_BINDINGS_JSON: "[]", SELECTION_REVIEW_DE_SERVICE_BINDINGS_JSON: "[]",
        SELECTION_REVIEW_C1_DRAFT_SERVICE_BINDINGS_JSON: JSON.stringify([{ schemaVersion: "c1-draft-service-binding-v1",
          provider: "terra", modelVersion: "gpt-5.6-terra", credentialAlias: "gateway-alias:synthetic:gate1-autopilot",
          workerId: "worker:synthetic:gate1-autopilot", workerVersion: "1", gatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
          configurationVersion: "synthetic:gate1-autopilot:1", leaseDurationMs: 90000 }]),
        SELECTION_REVIEW_CODEX_DISPATCH: "off", SELECTION_REVIEW_AUTO_DELIVER: "off" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.on("data", chunk => stderr.push(String(chunk)));
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => done(new Error(`API_START_TIMEOUT:stdout=${output}:stderr=${stderr.join("")}`)), 10000);
      const onData = chunk => { output += chunk; if (output.includes(base)) done(); };
      const onExit = (code, signal) => done(new Error(`API_START_FAILED:${code}:${signal}:${stderr.join("")}`));
      function done(error) {
        clearTimeout(timer); child.stdout.off("data", onData); child.off("error", done); child.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      child.stdout.on("data", onData); child.once("error", done); child.once("exit", onExit);
    });
    await authenticate(cookie ? "login" : "setup");
  }
  async function post(route, body, { authenticated = true } = {}) {
    const response = await fetch(`${base}${route}`, { method: "POST", headers: { Origin: base, "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json", ...(authenticated && cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function patch(id, body) {
    const response = await fetch(`${base}/api/candidates/${encodeURIComponent(id)}`, { method: "PATCH", headers: { Origin: base,
      "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function authenticate(action) {
    const response = await post(`/api/owner-access/${action}`, { password }, { authenticated: false });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    cookie = response.cookie.split(";")[0];
  }
  async function view(id) {
    const response = await fetch(`${base}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).candidates.find(item => item.id === id);
  }
  async function until(id, predicate) {
    for (let index = 0; index < 100; index += 1) {
      const current = await view(id);
      if (predicate(current)) return current;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`GATE1_AUTOPILOT_WAIT_TIMEOUT:${JSON.stringify((await view(id)).gate1AutopilotView)}:${stderr.join("")}`);
  }
  const continueRoute = id => `/api/candidates/${encodeURIComponent(id)}/gate1/autopilot/continue`;

  await t.test("有许可的商品：服务一开门软件就把整理好的材料准备成文案请求，停在付费那一步", async () => {
    const candidate = accepted(createSavedLocalPreparationCandidate({ at: new Date().toISOString() }), { grant: true });
    await start(candidate);
    const current = await until(candidate.id, item => item.gate1AutopilotView?.status === "waiting_owner");
    assert.deepEqual(current.gate1AutopilotView.stops.map(item => item.code), ["c1_paid_draft"]);
    assert.deepEqual(current.gate1AutopilotView.ranSteps.map(item => item.step), ["c1_prepare_copy"]);
    const saved = await readDocument();
    assert.ok(saved.candidates[0].lifecycleV11.c1AiDraftRequestV1);
    assert.equal(saved.candidates[0].dataRevision, candidate.dataRevision + 1);
    assert.equal(saved.runtime.softwareJobs.length, 0);
    assert.equal(saved.runtime.operationAudit.at(-1).actor.source, "gate1_autopilot");
    assert.equal(providerCalls, 0);
    const nothing = await post(continueRoute(candidate.id), { dataRevision: current.dataRevision });
    assert.equal(nothing.status, 409);
    assert.equal(nothing.body.code, "gate1_autopilot_nothing_to_do");
    assert.match(nothing.body.message, /允许这一次付费生成/u);
  });

  await t.test("没许可的商品：软件不动，主人点「让软件接着做」才算许可，当场做到停下", async () => {
    const candidate = accepted(createSavedLocalPreparationCandidate({ at: new Date().toISOString() }), { grant: false });
    await start(candidate);
    const bytes = await readFile(dataFile);
    const before = await view(candidate.id);
    assert.deepEqual([before.gate1AutopilotView.status, before.gate1AutopilotView.next.step], ["ready", "c1_prepare_copy"]);
    // 别的写入成功之后也会看一眼：没有许可就什么都不做。
    assert.equal((await post(`/api/candidates/${encodeURIComponent(candidate.id)}/comments`, { dataRevision: before.dataRevision, message: "看一眼" })).status, 201);
    await new Promise(resolve => setTimeout(resolve, 300));
    const afterComment = await readDocument();
    assert.equal(afterComment.candidates[0].dataRevision, candidate.dataRevision);
    assert.equal(afterComment.candidates[0].gate1AutopilotGrantV1, undefined);
    assert.notDeepEqual(await readFile(dataFile), bytes);

    assert.equal((await post(continueRoute(candidate.id), { dataRevision: before.dataRevision }, { authenticated: false })).status, 401);
    assert.equal((await post(continueRoute(candidate.id), { dataRevision: before.dataRevision - 1 })).status, 409);
    assert.equal((await post(continueRoute(candidate.id), { dataRevision: before.dataRevision, extra: true })).status, 400);
    const response = await post(continueRoute(candidate.id), { dataRevision: before.dataRevision });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // 点这一下本身改了修订号，材料就不是当前的了，所以先重新整理一次，再准备文案请求。
    assert.deepEqual(response.body.autopilot.ranSteps, ["c1_local_material", "c1_prepare_copy"]);
    assert.equal(response.body.candidate.gate1AutopilotView.status, "waiting_owner");
    const saved = (await readDocument()).candidates[0];
    assert.equal(saved.gate1AutopilotGrantV1.via, "owner_continue");
    assert.equal(saved.gate1AutopilotGrantV1.gate1DecidedAt, candidate.gate1DecisionV1.decidedAt);
    assert.equal(saved.gate1AutopilotGrantV1.skuPackageId, candidate.lifecycleV11.skuPackage.skuPackageId);
    assert.ok(saved.history.some(item => item.action === "gate1AutopilotContinued"));
    assert.ok(saved.lifecycleV11.c1AiDraftRequestV1);
    assert.equal(providerCalls, 0);
  });

  await t.test("某一步出错：记下来停住，不自己重试；主人之后改了资料也不再试；主人点「再试一次」才再做一次", async () => {
    const candidate = accepted(createSavedLocalPreparationCandidate({ at: new Date().toISOString() }), { grant: true });
    // 让整理材料那一步必然失败：计划里的规格号和 SKU 包对不上。
    candidate.lifecycleV11.skuPackage.c1ProductPlan.identity.supplierSkuId = "SYNTHETIC-OTHER-SKU";
    delete candidate.lifecycleV11.c1KeywordPlanningLocalMaterialV1;
    await start(candidate);
    const failed = await until(candidate.id, item => item.gate1AutopilotView?.status === "failed");
    assert.equal(failed.gate1AutopilotView.failure.step, "c1_local_material");
    assert.match(failed.gate1AutopilotView.line, /没有自己重试/u);
    assert.match(failed.gate1AutopilotView.line, /要它再做一次就点「让软件再试一次」/u);
    const record = (await readDocument()).candidates[0].gate1AutopilotV1;
    assert.equal(record.failure.sourceRevision, candidate.dataRevision);
    assert.equal(record.failure.grantId, candidate.gate1AutopilotGrantV1.grantId);
    // 出错的记录不加修订号；别的写入（留言不改修订号）之后再看一眼，也不会在同一份资料上重试。
    assert.equal((await readDocument()).candidates[0].dataRevision, candidate.dataRevision);
    assert.equal((await post(`/api/candidates/${encodeURIComponent(candidate.id)}/comments`, { dataRevision: candidate.dataRevision, message: "看一眼" })).status, 201);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual((await readDocument()).candidates[0].gate1AutopilotV1.failure, record.failure);
    // 主人之后改了别的资料（修订号变了），再有写入让软件看一眼：照样挡着，什么都不再做，运行记录一个字不变（AGENTS.md §8.3）。
    const edited = await patch(candidate.id, { dataRevision: candidate.dataRevision, notes: "主人补了一句备注" });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.candidate.dataRevision, candidate.dataRevision + 1);
    assert.equal((await post(`/api/candidates/${encodeURIComponent(candidate.id)}/comments`, { dataRevision: candidate.dataRevision + 1, message: "再看一眼" })).status, 201);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual((await readDocument()).candidates[0].gate1AutopilotV1, record);
    assert.equal((await view(candidate.id)).gate1AutopilotView.status, "failed");

    const retried = await post(continueRoute(candidate.id), { dataRevision: candidate.dataRevision + 1 });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.autopilot.status, "failed");
    const saved = (await readDocument()).candidates[0];
    assert.equal(saved.gate1AutopilotV1.failure.sourceRevision, candidate.dataRevision + 2);
    assert.ok(saved.history.some(item => item.action === "gate1AutopilotContinued" && /再试一次/u.test(item.detail)));
    assert.equal(providerCalls, 0);
  });

  await t.test("「做这件」卡上声明过品牌与权利：C1 计划一生成，软件就按那份声明记下，声明人是主人，不再停下等签", async () => {
    const formal = createFormalC1DraftFixture({ rightsReviewOptions: null });
    const candidate = structuredClone(formal.candidate);
    candidate.targetPlatform = formal.created.skuPackage.targetPlatform;
    candidate.storeRef = structuredClone(formal.created.skuPackage.g1Identity.storeRef);
    candidate.lifecycleV11.skuPackage = structuredClone(formal.created.skuPackage);
    assert.equal(candidate.lifecycleV11.skuPackage.c1ProductPlan.status, "inputs_ready");
    assert.equal(candidate.lifecycleV11.skuPackage.c1RightsReviewRecord ?? null, null);
    const decidedAt = new Date(Date.now() - 60000).toISOString();
    candidate.gate1DecisionV1 = { schemaVersion: "gate1-decision-v1", decision: "accept", decidedAt, decidedBy: "synthetic-owner",
      sourceRevision: candidate.dataRevision, roundIndex: 0 };
    candidate.gate1AutopilotGrantV1 = structuredClone(buildGate1AutopilotGrant({ candidateId: candidate.id, sourceRevision: candidate.dataRevision,
      decision: candidate.gate1DecisionV1, via: "gate1_accept", grantedAt: decidedAt, grantedBy: "synthetic-owner" }));
    candidate.gate1RightsDeclarationV1 = structuredClone(buildGate1RightsDeclaration({ candidateId: candidate.id, sourceRevision: candidate.dataRevision,
      input: { brandStatus: "unbranded", brandName: null, rights: "no_third_party_rights_identified", validMonths: 3 },
      decision: candidate.gate1DecisionV1, declaredByUserId: "synthetic-owner", declaredAt: decidedAt }));
    await start(candidate);
    const current = await until(candidate.id, item => item.gate1AutopilotView?.ranSteps?.some(step => step.step === "c1_apply_rights") &&
      item.gate1AutopilotView.status !== "running");
    const saved = (await readDocument()).candidates[0];
    const record = saved.lifecycleV11.skuPackage.c1RightsReviewRecord;
    assert.equal(record.declaredByUserId, "synthetic-owner");
    assert.deepEqual(record.ownerDeclaration.rights, { status: "verified", basis: "no_third_party_rights_identified" });
    assert.equal(record.ownerDeclaration.reviewedAt, decidedAt);
    assert.equal(current.gate1AutopilotView.ranSteps[0].step, "c1_apply_rights");
    assert.ok(!current.gate1AutopilotView.stops.some(item => /品牌与权利声明/u.test(item.line)), JSON.stringify(current.gate1AutopilotView));
    assert.ok((await readDocument()).runtime.operationAudit.some(item => item.action === "c1_sku_rights_gate1_declaration_apply" &&
      item.actor?.source === "gate1_autopilot"));
    assert.equal(providerCalls, 0);
  });
});
