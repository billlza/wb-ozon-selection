import test from "node:test";
import assert from "node:assert/strict";
import { acceptC2DraftReceipt, c2ReferenceFailureMessage, isExternalFileDrag, uploadC2Files } from "../src/c2UploadInput.js";
import { createSubmitLock } from "../src/formState.js";

const context = { candidateId: "candidate:test", dataRevision: 60, draftRevision: 4 };
const receipt = revision => ({ candidateId: context.candidateId, dataRevision: context.dataRevision,
  draft: { candidateId: context.candidateId, sourceCandidateRevision: context.dataRevision, revision } });

test("external file drags are distinct from image sorting and browser URLs", () => {
  assert.equal(isExternalFileDrag({ types: ["Files", "text/plain"] }), true);
  assert.equal(isExternalFileDrag({ types: ["text/uri-list", "text/html"] }), false);
  assert.equal(isExternalFileDrag({ types: [] }), false);
});

test("batch uploads are sequential and each acknowledged draft advances the next request", async () => {
  const requests = [], received = [], progress = [];
  await uploadC2Files([{ name: "one.png" }, { name: "two.png" }], { ...context,
    upload: async (file, input) => { requests.push([file.name, input]); return receipt(input.draftRevision + 2); },
    receive: draft => received.push(draft.revision), progress: update => progress.push(update) });
  assert.deepEqual(requests, [["one.png", { dataRevision: 60, draftRevision: 4 }], ["two.png", { dataRevision: 60, draftRevision: 6 }]]);
  assert.deepEqual(received, [6, 8]);
  assert.deepEqual(progress.at(-1), { total: 2, saved: 2, current: "", failed: false });
});

test("a rejected second file preserves the first receipt and never sends remaining files", async () => {
  const failure = new Error("invalid image"), requests = [], received = [], progress = [];
  await assert.rejects(uploadC2Files([{ name: "one.png" }, { name: "bad.png" }, { name: "three.png" }], { ...context,
    upload: async (file, input) => { requests.push(file.name); if (file.name === "bad.png") throw failure; return receipt(input.draftRevision + 2); },
    receive: draft => received.push(draft.revision), progress: update => progress.push(update) }), error => error === failure);
  assert.deepEqual(requests, ["one.png", "bad.png"]);
  assert.deepEqual(received, [6]);
  assert.deepEqual(progress.at(-1), { total: 3, saved: 1, current: "bad.png", failed: true });
});

test("receipts require exact candidate, source revision and operation revision advance", () => {
  const expected = { ...context, revisionAdvance: 2 };
  assert.equal(acceptC2DraftReceipt(receipt(6), expected).revision, 6);
  for (const invalid of [receipt(5), receipt(7), { ...receipt(6), candidateId: "other" },
    { ...receipt(6), dataRevision: 61 }, { ...receipt(6), draft: { ...receipt(6).draft, sourceCandidateRevision: 61 } }]) {
    assert.throws(() => acceptC2DraftReceipt(invalid, expected), /回执与本次商品或修订不一致/);
  }
  assert.throws(() => acceptC2DraftReceipt(receipt(6), { ...expected, draftRevision: 6 }), /回执与本次商品或修订不一致/);
  assert.equal(acceptC2DraftReceipt(receipt(5), { ...context, revisionAdvance: 1 }).revision, 5);
});

test("a stale receipt during the batch cannot replace the last saved draft or start the next file", async () => {
  let calls = 0;
  const received = [], progress = [];
  await assert.rejects(uploadC2Files([{ name: "one.png" }, { name: "two.png" }, { name: "three.png" }], { ...context,
    upload: async () => { calls += 1; return receipt(6); },
    receive: draft => received.push(draft.revision), progress: update => progress.push(update) }), /回执与本次商品或修订不一致/);
  assert.equal(calls, 2);
  assert.deepEqual(received, [6]);
  assert.deepEqual(progress.at(-1), { total: 3, saved: 1, current: "two.png", failed: true });
});

test("the shared submit lock prevents overlapping batches before the first receipt", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const run = createSubmitLock();
  const batch = () => uploadC2Files([{ name: "one.png" }], { ...context,
    upload: async () => { calls += 1; await pending; return receipt(6); }, receive: () => {}, progress: () => {} });
  const first = run(batch);
  assert.equal(await run(batch), undefined);
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(calls, 1);
});

test("only the exact C2 reference failure receives a short message without diagnostic payload", () => {
  const diagnostic = "C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED:$.sourceRef:private-payload";
  assert.match(c2ReferenceFailureMessage(diagnostic), /方案卡暂未生成/);
  assert.doesNotMatch(c2ReferenceFailureMessage(diagnostic), /private-payload|sourceRef/);
  assert.equal(c2ReferenceFailureMessage("C2_REFERENCE_CONTRACT_MIGRATION_REQUIRED_OTHER"), null);
  assert.equal(c2ReferenceFailureMessage("network error"), null);
});
