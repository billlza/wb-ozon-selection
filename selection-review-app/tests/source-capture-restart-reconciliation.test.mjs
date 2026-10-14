import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { stopApiProcess, allocatedTestPorts } from "./helpers/api-process-lifecycle.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { api: firstPort, second: secondPort } = allocatedTestPorts();

function baseCandidate(id) {
  return {
    id,
    source: "user",
    group: "userAdded",
    targetStore: "dandanshu",
    productName: `重启测试 ${id}`,
    productUrl: "https://www.ozon.ru/product/test-4403916892/",
    sourceUrl: "https://qr.1688.com/s/7OnLCakq",
    workflowStatus: "codex_processing",
    dataRevision: 7,
    processing: { state: "idle", manualHold: true },
    lifecycleV11: {
      schemaVersion: "product-lifecycle-v1.1",
      status: "opportunity_sales_snapshot_captured",
      opportunityPackage: { schemaVersion: "product-lifecycle-v1.1", entityType: "OpportunityPackage" },
      platformWrites: 0
    },
    comments: [],
    history: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z"
  };
}

function orphanCandidate(id, kind) {
  const candidate = baseCandidate(id);
  candidate.sourceCapture = {
    captureId: `SCJ-${id}`,
    jobId: `SCJ-${id}`,
    mode: "a_supplier_capture",
    status: kind === "claimed" ? "capturing" : "waiting_extension",
    jobStatus: kind,
    attempt: kind === "claimed" ? 1 : 0,
    sourceUrl: candidate.sourceUrl,
    originalSourceUrl: candidate.sourceUrl,
    requiredExtensionVersion: "1.4.1",
    token: "must-not-survive-restart",
    extensionRequest: { token: "must-not-survive-restart" },
    writeOccurred: false,
    businessStateEffect: "unchanged"
  };
  return candidate;
}

function document(candidates) {
  return {
    meta: { version: 2, title: "restart-test", updatedAt: "2026-08-19T00:00:00.000Z", automationStarted: false },
    rules: {},
    candidates,
    dispatches: [],
    nodeDispatches: [],
    workflowComments: [],
    controlAlerts: [],
    evidencePacks: []
  };
}

async function waitForHealth(child, baseUrl, stderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：${stderr.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`测试服务未启动：${stderr.join("")}`);
}

async function startServer(t, dataFile, port) {
  const stderr = [];
  const child = spawn(process.execPath, [path.join(appDir, "server.mjs"), "--api-only"], {
    cwd: appDir,
    env: {
      ...process.env,
      SELECTION_REVIEW_DATA_FILE: dataFile,
      SELECTION_REVIEW_API_PORT: String(port),
      SELECTION_REVIEW_ALLOWED_EXTENSION_ORIGINS: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      SELECTION_REVIEW_AUTO_DELIVER: "off",
      SELECTION_REVIEW_CODEX_DISPATCH: "off"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  t.after(() => stopApiProcess(child));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(child, baseUrl, stderr);
  return { child, baseUrl };
}

/**
 * 采集会话只活在创建它的进程内存里。服务一重启，任何还在等插件或正在采的持久化记录都不可能再有结果；留着它，
 * previous_capture_requires_review 还会因此拒绝这件商品之后的每一次采集申请（主人 2026-09-11 被彻底卡住）。
 * 所以启动时只做一件事：把这类记录一次性收口为失败，且因为我们从未收到结果，writeOccurred 必须是 false。
 */
test("重启把等不到结果的采集一次性收口为失败，不领取旧作业，也不重复写盘", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "source-capture-restart-"));
  const residualFile = path.join(directory, "residual.json");
  const queued = orphanCandidate("A-QUEUED", "queued");
  const claimed = orphanCandidate("A-CLAIMED", "claimed");
  const untouched = baseCandidate("OTHER-UNTOUCHED");
  await writeFile(residualFile, JSON.stringify(document([queued, claimed, untouched]), null, 2));

  const before = JSON.parse(await readFile(residualFile, "utf8"));
  const { baseUrl, child } = await startServer(t, residualFile, firstPort);
  const reconciledText = await readFile(residualFile, "utf8");
  assert.notEqual(reconciledText, JSON.stringify(before, null, 2), "等不到结果的记录必须被收口");
  assert.doesNotMatch(reconciledText, /must-not-survive-restart/, "重启后不得继续保留旧作业的一次性凭据");
  const reconciled = JSON.parse(reconciledText);
  for (const id of [queued.id, claimed.id]) {
    const capture = reconciled.candidates.find(item => item.id === id).sourceCapture;
    assert.equal(capture.status, "failed", `${id} 必须收口`);
    assert.equal(capture.failureCode, "capture_job_lost");
    assert.equal(capture.jobStatus, "failed");
    assert.equal(capture.reason, "服务已重启，这次采集不会再有结果，请重新申请采集");
    assert.equal(capture.writeOccurred, false, "我们从未收到结果，不能声称写过");
    assert.equal(capture.captureId, `SCJ-${id}`);
    assert.equal(capture.token, undefined);
    assert.equal(capture.extensionRequest, undefined);
  }
  // 业务状态不动：没有选择SKU、没有派发、没有平台写入，其他候选一个字节都不变。
  for (const id of [queued.id, claimed.id]) {
    const candidate = reconciled.candidates.find(item => item.id === id);
    assert.equal(candidate.workflowStatus, "codex_processing");
    assert.equal(candidate.lifecycleV11.platformWrites, 0);
    assert.equal(candidate.dataRevision, 8, "收口是一次系统写入，只推进一次修订号");
    assert.equal(candidate.history.at(-1).action, "aSupplierCaptureStopped");
  }
  assert.equal(JSON.stringify(reconciled.candidates.find(item => item.id === untouched.id)),
    JSON.stringify(before.candidates.find(item => item.id === untouched.id)), "与本次采集无关的候选不得改动");
  assert.deepEqual(reconciled.dispatches, []);

  const state = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(state.captureControl.status, "idle");
  assert.equal(state.candidates.find(item => item.id === queued.id).sourceCapture.token, undefined);
  assert.equal(state.candidates.find(item => item.id === claimed.id).sourceCapture.extensionRequest, undefined);
  const runtime = await (await fetch(`${baseUrl}/api/integrations/seerfar/runtime-status`)).json();
  assert.equal(runtime.credentialStatus, "not_checked");
  assert.equal(runtime.configured, null);
  assert.equal(await readFile(residualFile, "utf8"), reconciledText, "只读接口不得再写盘");
  const claim = await fetch(`${baseUrl}/api/extension/capture-jobs/SCJ-A-QUEUED/claim`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    body: JSON.stringify({ version: "1.4.1" })
  });
  assert.equal(claim.status, 409);
  assert.equal((await claim.json()).code, "capture_job_not_current");
  const heartbeat = await fetch(`${baseUrl}/api/extension/heartbeat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    body: JSON.stringify({ version: "1.4.1", backgroundReady: true, observedAt: new Date().toISOString() })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).captureJob, null, "重启后不得重建、恢复或重新领取旧作业");

  assert.equal(await readFile(residualFile, "utf8"), reconciledText);
  await stopApiProcess(child);
  await startServer(t, residualFile, secondPort);
  assert.equal(await readFile(residualFile, "utf8"), reconciledText, "已经收口过，再次重启不得重复写盘");

  // 没有这类记录时，启动完全不碰业务数据。
  const cleanFile = path.join(directory, "clean.json");
  await writeFile(cleanFile, JSON.stringify(document([baseCandidate("CLEAN-ONLY")]), null, 2));
  const cleanBefore = await readFile(cleanFile, "utf8");
  await startServer(t, cleanFile, firstPort);
  assert.equal(await readFile(cleanFile, "utf8"), cleanBefore, "没有等不到结果的采集记录时，启动不得产生任何写入");
});
