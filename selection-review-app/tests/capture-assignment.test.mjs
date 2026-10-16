import assert from "node:assert/strict";
import test from "node:test";

import { ANY_COMPUTER, captureControlView, captureHolder, claimantFor, claimantWorkstationId, computersReadyForSoftwareJob,
  PAGE_WORKSTATION_HEADER, pageWorkstationId, teamCaptureControl, teamCaptureRefusal, teamClaimRefusal } from "../lib/capture-assignment.mjs";
import { captureBlockFor } from "../src/captureControlView.js";
import { headerStatusIndicator } from "../src/headerStatusView.js";

// Synthetic computers and products only.
const A = "workstation:00000000-0000-4000-8000-00000000000a";
const B = "workstation:00000000-0000-4000-8000-00000000000b";
const C = "workstation:00000000-0000-4000-8000-00000000000c";
const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NAMES = { [A]: "老板甲的 MacBook", [B]: "测试丙的电脑", [C]: "老板乙的电脑" };
const online = new Set([A, B, C]);
const presence = workstationId => ({ online: online.has(workstationId), name: NAMES[workstationId] ?? null });

function job(overrides) {
  return { captureId: "SCJ-1", candidateId: "P-1", label: "P-1", platform: "1688", captureKind: "supplier", createdAt: 1_000,
    claimedAt: null, expiresAt: 61_000, jobStatus: "queued", holder: null, ...overrides };
}

test("a page names its computer in one header; a claim names the plugin and the computer, and either gives the computer back", () => {
  assert.equal(PAGE_WORKSTATION_HEADER, "x-selection-review-workstation");
  assert.equal(pageWorkstationId({ headers: { [PAGE_WORKSTATION_HEADER]: A } }), A);
  for (const value of [undefined, "", "workstation:not-an-id", `${A} `, [A], "local"]) {
    assert.equal(pageWorkstationId({ headers: { [PAGE_WORKSTATION_HEADER]: value } }), null, String(value));
  }
  assert.equal(pageWorkstationId(undefined), null);
  assert.equal(claimantFor(ORIGIN, A), `${ORIGIN} ${A}`);
  assert.equal(claimantFor(ORIGIN, null), ORIGIN, "without team accounts the plugin's origin alone, as before");
  assert.equal(claimantWorkstationId(`${ORIGIN} ${A}`), A);
  assert.equal(claimantWorkstationId(ORIGIN), null);
  assert.equal(claimantWorkstationId(""), null);
  // The computer a job keeps busy: the one it was started for, else the one that claimed it, else none yet.
  assert.equal(captureHolder({ assignedTo: A, claimedBy: "" }), A);
  assert.equal(captureHolder({ assignedTo: null, claimedBy: `${ORIGIN} ${B}` }), B);
  assert.equal(captureHolder({ assignedTo: null, claimedBy: "" }), null);
  assert.equal(captureHolder({ claimedBy: ORIGIN }), null);
});

test("under team accounts a new job is refused only for its own product or its own computer, with one plain reason each", () => {
  const busyOnA = job({ captureId: "SCJ-A", candidateId: "P-1", label: "P-1", holder: A });
  const queuedForAnyone = job({ captureId: "IMJ-Q", candidateId: "P-3", label: "P-3", holder: null, captureKind: "image_match", createdAt: 2_000 });
  const active = [busyOnA, queuedForAnyone];
  // Another computer, another product: free to start.
  assert.equal(teamCaptureRefusal({ active, candidateId: "P-2", forComputer: B, presence }), null);
  // The software's own job only cares about the product.
  assert.equal(teamCaptureRefusal({ active, candidateId: "P-2", forComputer: ANY_COMPUTER, presence }), null);
  const cases = [
    [{ candidateId: "P-2", forComputer: null }, "workstation_not_added", /还没加进来.*作业没有建/u],
    [{ candidateId: "P-2", forComputer: "workstation:bad" }, "workstation_not_added", /还没加进来/u],
    [{ candidateId: "P-2", forComputer: "workstation:00000000-0000-4000-8000-0000000000ff" }, "workstation_offline", /没连上服务/u],
    [{ candidateId: "P-1", forComputer: B }, "capture_candidate_busy", /「老板甲的 MacBook」采集/u],
    [{ candidateId: "P-1", forComputer: ANY_COMPUTER }, "capture_candidate_busy", /「老板甲的 MacBook」采集/u],
    [{ candidateId: "P-3", forComputer: B }, "capture_candidate_busy", /已经有一个采集作业在排着或在跑/u],
    [{ candidateId: "P-2", forComputer: A }, "workstation_busy", /这台电脑的插件正在采集 P-1.*别的电脑照常/u]
  ];
  for (const [input, code, message] of cases) {
    const refusal = teamCaptureRefusal({ active, presence, ...input });
    assert.equal(refusal?.code, code, JSON.stringify(input));
    assert.match(refusal.message, message);
    assert.match(refusal.message, code.startsWith("workstation_not") || code === "workstation_offline" ? /作业没有建/u : /不会排队或自动重试/u);
  }
  // A Seerfar round has no product: only the computer counts.
  const seerfar = job({ captureId: "SWR-1", candidateId: null, label: "Seerfar 榜单", platform: "seerfar", holder: C });
  assert.equal(teamCaptureRefusal({ active: [seerfar], candidateId: null, forComputer: A, presence }), null);
  assert.match(teamCaptureRefusal({ active: [seerfar], candidateId: "P-9", forComputer: C, presence }).message, /正在采集 Seerfar 榜单/u);
});

test("a computer claims only a job that is for it or for anyone, and only while it holds no other job", () => {
  const forA = job({ captureId: "SCJ-A", holder: A });
  const forA2 = { captureId: "SCJ-A", assignedTo: A, claimedBy: "" };
  const forAnyone = { captureId: "IMJ-Q", assignedTo: null, claimedBy: "" };
  assert.equal(teamClaimRefusal({ session: forA2, active: [forA], workstationId: A }), null);
  assert.equal(teamClaimRefusal({ session: forA2, active: [forA], workstationId: B })?.code, "capture_job_for_other_computer");
  assert.equal(teamClaimRefusal({ session: forAnyone, active: [forA], workstationId: B }), null);
  assert.equal(teamClaimRefusal({ session: forAnyone, active: [forA], workstationId: A })?.code, "workstation_busy");
  // A job the service does not know is left to the claim itself, which says so in its own words.
  assert.equal(teamClaimRefusal({ session: null, active: [forA], workstationId: B }), null);
});

test("a page sees its own computer's job as the control, and other computers' products by name", () => {
  const onA = job({ captureId: "SCJ-A", candidateId: "P-1", label: "P-1", holder: A, jobStatus: "claimed", claimedAt: 5_000 });
  const onB = job({ captureId: "OPR-B", candidateId: "P-2", label: "P-2", platform: "ozon", captureKind: "sales", holder: B, createdAt: 2_000 });
  const queued = job({ captureId: "IMJ-Q", candidateId: "P-3", label: "P-3", holder: null, createdAt: 3_000 });
  const fromA = teamCaptureControl({ active: [onA, onB, queued], workstationId: A, presence });
  assert.deepEqual(fromA, { status: "busy", label: "这台电脑正在采集 P-1（1688）", candidateId: "P-1", captureId: "SCJ-A", platform: "1688",
    captureKind: "supplier", startedAt: new Date(5_000).toISOString(), expiresAt: new Date(61_000).toISOString(), scope: "this_computer",
    elsewhere: [{ candidateId: "P-2", platform: "ozon", captureKind: "sales", computer: "测试丙的电脑" },
      { candidateId: "P-3", platform: "1688", captureKind: "supplier", computer: null }] });
  const fromC = teamCaptureControl({ active: [onA, onB], workstationId: C, presence });
  assert.equal(fromC.status, "idle");
  assert.equal(fromC.label, "这台电脑的采集空闲");
  assert.deepEqual(fromC.elsewhere.map(item => item.computer), ["老板甲的 MacBook", "测试丙的电脑"]);
  // A page whose plugin has not said which computer it is on runs nothing, and sees every product another computer has.
  assert.equal(teamCaptureControl({ active: [onA], workstationId: null, presence }).elsewhere.length, 1);
  // Without team accounts the view keeps the shape it always had.
  assert.deepEqual(captureControlView(null, { idleLabel: "商品采集控制空闲" }), { status: "idle", label: "商品采集控制空闲", candidateId: null,
    captureId: null, platform: null, captureKind: null, startedAt: null, expiresAt: null });
});

test("the software's own job goes to a computer that is online, current, has a page open and runs nothing", () => {
  const computer = (workstationId, overrides = {}) => ({ workstationId, name: NAMES[workstationId], version: "1.6.0", backgroundReady: true, ...overrides });
  const pages = new Set([A, B, C]);
  const ready = (online, active) => computersReadyForSoftwareJob({ online, active, requiredVersion: "1.6.0",
    pageSeenLately: workstationId => pages.has(workstationId) }).map(item => item.workstationId);
  assert.deepEqual(ready([computer(A), computer(B), computer(C)], []), [A, B, C]);
  // Busy with a job, old plugin, background not answering, or no page open on it: not this one.
  assert.deepEqual(ready([computer(A), computer(B, { version: "1.5.0" }), computer(C, { backgroundReady: false })],
    [job({ holder: A })]), []);
  pages.delete(B);
  assert.deepEqual(ready([computer(A), computer(B)], []), [A]);
  // A queued job nobody has claimed yet keeps no computer busy.
  assert.deepEqual(ready([computer(A)], [job({ holder: null })]), [A]);
});

test("the product's buttons and the header say whose job it is", () => {
  const control = { status: "idle", label: "这台电脑的采集空闲", scope: "this_computer",
    elsewhere: [{ candidateId: "P-2", platform: "ozon", captureKind: "sales", computer: "测试丙的电脑" },
      { candidateId: "P-3", platform: "1688", captureKind: "supplier", computer: null }] };
  assert.deepEqual(captureBlockFor(control, "P-1"), { busy: false, label: "", button: "" });
  assert.deepEqual(captureBlockFor(control, "P-2"), { busy: true, label: "「测试丙的电脑」正在采集这件商品", button: "别的电脑正在采集这件" });
  assert.equal(captureBlockFor(control, "P-3").label, "另一台电脑正在采集这件商品");
  const mine = { ...control, status: "busy", label: "这台电脑正在采集 P-1（1688）", candidateId: "P-1", platform: "1688" };
  assert.deepEqual(captureBlockFor(mine, "P-4"), { busy: true, label: "这台电脑正在采集 P-1（1688）", button: "这台电脑正在采集" });
  // The single control of the owner's Mac reads as before.
  assert.deepEqual(captureBlockFor({ status: "busy", label: "商品采集控制已由 P-1 占用（1688）" }, "P-4"),
    { busy: true, label: "商品采集控制已由 P-1 占用（1688）", button: "其他商品正在采集" });
  assert.equal(captureBlockFor(null, "P-1").busy, false);

  const header = headerStatusIndicator({ extensionStatus: { code: "connected", label: "插件已连接" }, captureControl: mine,
    runtimeArchitecture: null });
  assert.match(header.issues.find(issue => issue.source === "capture").sentence, /^这台电脑正在采集 P-1（1688），这台电脑上别的商品要等它结束；别的电脑照常能用$/u);
  const idleHere = headerStatusIndicator({ extensionStatus: { code: "connected", label: "插件已连接" }, captureControl: control, runtimeArchitecture: null });
  assert.equal(idleHere.issues.some(issue => issue.source === "capture"), false, "other computers' work is not this computer's problem");
});
