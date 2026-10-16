import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleBusinessState,
  assertNoNewKeyConflicts,
  createIndexPositionAllocator,
  decodeCandidatePart,
  decodeSharedPart,
  encodeCandidatePart,
  encodeSharedPart,
  longestPartitionedCollection,
  partitionKeys,
  sameSharedState,
  splitBusinessState,
  splitBusinessStateResult,
  withPartitionedRecords
} from "../lib/business-state-partitions.mjs";

const clone = value => JSON.parse(JSON.stringify(value));

// Two candidates whose own records sit between each other's and between shared ones, in every kind of collection.
function storedDocument() {
  return {
    meta: { version: 2, title: "评审台" },
    rules: { margin: 0.3 },
    candidates: [{ id: "A", title: "背心" }, { id: "B", title: "外套" }],
    dispatches: [
      { id: "d-a1", candidateId: "A" },
      { id: "d-shared", candidateId: null },
      { id: "d-b1", candidateId: "B" },
      { id: "d-a2", candidateId: "A" }
    ],
    collaboration: { messages: [{ text: "大家好" }], delivery: [] },
    runtime: {
      operationAudit: [{ action: "start" }, { action: "save", candidateId: "B" }, { action: "save", candidateId: "A" }],
      idempotencyRecords: [{ idempotencyKey: "k-a", candidateId: "A" }, { idempotencyKey: "k-b", candidateId: "B" }],
      softwareJobs: [
        { jobId: "j-a", subject: { kind: "a_candidate", candidateId: "A" } },
        { jobId: "j-batch", subject: { kind: "batch", candidateIds: ["A", "B"] } }
      ],
      softwareJobAuthorizationRecords: [{ authorizationId: "auth-b", scopeBinding: { candidateId: "B" } }],
      wbCredentialsVersion: 3
    }
  };
}

function loadedFor(split, scope) {
  return { shared: split.shared, parts: new Map(scope.filter(id => split.parts.has(id)).map(id => [id, split.parts.get(id)])) };
}

// Runs one single-candidate transaction the way the file and memory adapters do and returns the whole stored result.
async function scopedWrite(document, scope, mutate) {
  const split = splitBusinessState(document);
  const loaded = loadedFor(split, scope);
  const view = clone(assembleBusinessState(loaded.shared, loaded.parts.values()));
  mutate(view);
  const next = await splitBusinessStateResult(view, loaded, { scope: new Set(scope), allocate: createIndexPositionAllocator(split) });
  const parts = new Map(split.parts);
  for (const [candidateId, part] of next.parts) {
    if (part === null) parts.delete(candidateId);
    else parts.set(candidateId, part);
  }
  return { next, document: assembleBusinessState(split.shared, parts.values()) };
}

test("按商品拆开再拼回，整份数据一字不差（包括字段顺序）", () => {
  const document = storedDocument();
  const split = splitBusinessState(document);
  assert.deepEqual([...split.parts.keys()].sort(), ["A", "B"]);
  assert.equal(JSON.stringify(assembleBusinessState(split.shared, split.parts.values())), JSON.stringify(document));
  assert.deepEqual(document, storedDocument(), "拆分不改动原数据");

  const encoded = JSON.parse(JSON.stringify({ shared: encodeSharedPart(split.shared),
    parts: [...split.parts.values()].map(encodeCandidatePart) }));
  const decoded = assembleBusinessState(decodeSharedPart(encoded.shared),
    encoded.parts.map(part => decodeCandidatePart(part, part.candidateId)));
  assert.equal(JSON.stringify(decoded), JSON.stringify(document), "存成行再读回来也一样");
});

test("每件商品那份只装它自己的记录，几件商品共用或不属于商品的留在共用那份", () => {
  const split = splitBusinessState(storedDocument());
  const a = split.parts.get("A").collections;
  assert.deepEqual(a.candidates.records, [{ id: "A", title: "背心" }]);
  assert.deepEqual(a.dispatches.records.map(record => record.id), ["d-a1", "d-a2"]);
  assert.deepEqual(a["runtime.softwareJobs"].records.map(job => job.jobId), ["j-a"]);
  assert.equal(split.parts.get("B").collections["runtime.softwareJobAuthorizationRecords"].records[0].authorizationId, "auth-b");

  const shared = split.shared.document;
  assert.deepEqual(shared.candidates, []);
  assert.deepEqual(shared.dispatches.map(record => record.id), ["d-shared"]);
  assert.deepEqual(shared.runtime.softwareJobs.map(job => job.jobId), ["j-batch"]);
  assert.deepEqual(shared.runtime.operationAudit, [{ action: "start" }]);
  assert.equal(shared.runtime.wbCredentialsVersion, 3);
  assert.deepEqual(shared.collaboration, { messages: [{ text: "大家好" }], delivery: [] });

  const malformed = splitBusinessState({ candidates: [], dispatches: [{ id: "d-x", candidateId: 7 }, { id: "d-y", candidateId: "" }] });
  assert.equal(malformed.parts.size, 0, "商品编号不是正常字符串的记录不归任何商品");
  assert.equal(malformed.shared.document.dispatches.length, 2);

  assert.throws(() => splitBusinessState({ candidates: [{ id: "A" }, { id: "A" }] }), /BUSINESS_STATE_PARTITION_DUPLICATE:candidates/u);
  assert.throws(() => splitBusinessState([]), /BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID/u);
});

test("单件商品的写入只改它那份，新记录排在最后", async () => {
  const { next, document } = await scopedWrite(storedDocument(), ["A"], view => {
    view.dispatches.push({ id: "d-a3", candidateId: "A" });
    view.candidates[0].title = "小猫背心";
  });
  assert.equal(next.shared, null);
  assert.deepEqual([...next.parts.keys()], ["A"]);
  assert.deepEqual(document.dispatches.map(record => record.id), ["d-a1", "d-shared", "d-b1", "d-a2", "d-a3"]);
  assert.equal(document.candidates[0].title, "小猫背心");
  assert.deepEqual(document.candidates.map(candidate => candidate.id), ["A", "B"]);
});

test("单件商品在自己的记录前面插入，它自己的顺序保持准确", async () => {
  const { document } = await scopedWrite(storedDocument(), ["A"], view => {
    view.runtime.idempotencyRecords.unshift({ idempotencyKey: "k-a0", candidateId: "A" });
  });
  const own = document.runtime.idempotencyRecords.filter(record => record.candidateId === "A").map(record => record.idempotencyKey);
  assert.deepEqual(own, ["k-a0", "k-a"]);
  assert.equal(document.runtime.idempotencyRecords.length, 3);
});

test("新建的商品排在最前；整份写入可以随意重排", async () => {
  const created = await scopedWrite(storedDocument(), ["C"], view => {
    view.candidates.unshift({ id: "C", title: "新品" });
  });
  assert.deepEqual(created.document.candidates.map(candidate => candidate.id), ["C", "A", "B"]);

  const split = splitBusinessState(storedDocument());
  const reordered = clone(storedDocument());
  reordered.candidates.reverse();
  reordered.dispatches.splice(1, 0, { id: "d-b0", candidateId: "B" });
  const next = await splitBusinessStateResult(reordered,
    { shared: split.shared, parts: new Map(split.parts) }, { scope: null, allocate: createIndexPositionAllocator(split) });
  const parts = new Map(split.parts);
  for (const [candidateId, part] of next.parts) parts.set(candidateId, part);
  const document = assembleBusinessState(next.shared ?? split.shared, parts.values());
  assert.deepEqual(document.candidates.map(candidate => candidate.id), ["B", "A"]);
  assert.deepEqual(document.dispatches.map(record => record.id), ["d-a1", "d-b0", "d-shared", "d-b1", "d-a2"]);
});

test("单件商品的写入改不了共用设置，也碰不到别的商品", async () => {
  await assert.rejects(scopedWrite(storedDocument(), ["A"], view => { view.rules.margin = 0.5; }),
    /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:shared/u);
  await assert.rejects(scopedWrite(storedDocument(), ["A"], view => { view.dispatches.push({ id: "d-shared-2" }); }),
    /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:shared/u, "不属于商品的新记录也算改共用");
  await assert.rejects(scopedWrite(storedDocument(), ["A"], view => { view.dispatches.push({ id: "d-b2", candidateId: "B" }); }),
    /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:dispatches:B/u);
  await assert.rejects(scopedWrite(storedDocument(), [], view => { view.candidates.push({ id: "A" }); }),
    /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:candidates:A/u, "空范围什么都存不了");
});

test("单件商品第一次用到某类记录时新建的空列表不算改共用", async () => {
  const document = { meta: { version: 2 }, candidates: [{ id: "A" }] };
  const { next, document: stored } = await scopedWrite(document, ["A"], view => {
    view.runtime = { softwareJobs: [{ jobId: "j-1", candidateId: "A" }] };
    view.dispatches = [];
  });
  assert.equal(next.shared, null);
  assert.deepEqual(stored.runtime.softwareJobs, [{ jobId: "j-1", candidateId: "A" }]);
  assert.equal(Object.hasOwn(stored, "dispatches"), false);

  const emptyShared = { meta: { version: 2 }, candidates: [{ id: "A" }], productionEntityRecords: [], runtime: { idempotencyRecords: [] } };
  const leftOut = await scopedWrite(emptyShared, ["A"], view => {
    delete view.productionEntityRecords;
    delete view.runtime;
    view.candidates[0].title = "改过";
  });
  assert.equal(leftOut.next.shared, null, "共用部分本来就是空列表，写回时没带上也不算改共用");
  assert.deepEqual(leftOut.document, { ...emptyShared, candidates: [{ id: "A", title: "改过" }] });
  await assert.rejects(scopedWrite(storedDocument(), ["A"], view => { delete view.dispatches; }),
    /BUSINESS_STATE_REPOSITORY_SCOPE_VIOLATION:shared/u, "共用部分有记录的列表不能整个丢掉");

  const removed = await scopedWrite(storedDocument(), ["B"], view => {
    view.candidates = view.candidates.filter(candidate => candidate.id !== "B");
    view.dispatches = view.dispatches.filter(record => record.candidateId !== "B");
    view.runtime.operationAudit = view.runtime.operationAudit.filter(record => record.candidateId !== "B");
    view.runtime.idempotencyRecords = [];
    view.runtime.softwareJobAuthorizationRecords = [];
  });
  assert.equal(removed.next.parts.get("B"), null, "记录都删光了，这件商品那份就不要了");
  assert.deepEqual(removed.document.candidates.map(candidate => candidate.id), ["A"]);
});

test("比较共用部分时不看按商品存的记录，只装这些记录的空 runtime 也不算", () => {
  const left = storedDocument();
  const right = clone(left);
  right.candidates.push({ id: "C" });
  right.runtime.idempotencyRecords = [];
  assert.equal(sameSharedState(left, right), true);
  right.rules.margin = 0.4;
  assert.equal(sameSharedState(left, right), false);

  assert.equal(sameSharedState({ meta: {} }, { meta: {}, runtime: { operationAudit: [] } }), true);
  assert.equal(sameSharedState({ meta: {} }, { meta: {}, runtime: { operationAudit: [], other: 1 } }), false);
});

test("把按商品存的记录换进另一份数据，别的不动，不凭空多出空列表", () => {
  const base = { meta: { version: 2 }, rules: { margin: 0.3 }, candidates: [{ id: "A" }], dispatches: [{ id: "d-1" }] };
  const from = { meta: { version: 9 }, rules: { margin: 0.9 }, candidates: [{ id: "A", title: "改过" }],
    runtime: { idempotencyRecords: [] } };
  const result = withPartitionedRecords(base, from);
  assert.deepEqual(result, { meta: { version: 2 }, rules: { margin: 0.3 }, candidates: [{ id: "A", title: "改过" }], dispatches: [] });
  assert.deepEqual(base.dispatches, [{ id: "d-1" }], "不改动原数据");

  const withJobs = withPartitionedRecords(base, { runtime: { softwareJobs: [{ jobId: "j-1" }] } });
  assert.deepEqual(withJobs.runtime, { softwareJobs: [{ jobId: "j-1" }] });
  assert.deepEqual(withJobs.candidates, []);
});

test("唯一编号不能被第二件商品拿走，旧数据里本来就重复的不追究", () => {
  const split = splitBusinessState(storedDocument());
  assert.deepEqual([...partitionKeys(split.parts.get("A").collections)].sort(),
    ["dispatch\u0000d-a1", "dispatch\u0000d-a2", "idempotency\u0000k-a", "software_job\u0000j-a"]);

  const sameKey = clone(storedDocument());
  sameKey.runtime.idempotencyRecords.push({ idempotencyKey: "k-a", candidateId: "B" });
  assert.throws(() => assertNoNewKeyConflicts(split, splitBusinessState(sameKey)),
    error => error.code === "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT" && error.message === "BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT");

  const sameJob = clone(storedDocument());
  sameJob.runtime.softwareJobs.push({ jobId: "j-a", candidateId: "B" });
  assert.throws(() => assertNoNewKeyConflicts(split, splitBusinessState(sameJob)),
    error => error.code === "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT" && error.message === "BUSINESS_STATE_REPOSITORY_KEY_CONFLICT:software_job");

  const legacy = splitBusinessState(sameKey);
  assert.doesNotThrow(() => assertNoNewKeyConflicts(legacy, legacy));
  const third = clone(sameKey);
  third.candidates.push({ id: "C" });
  third.runtime.idempotencyRecords.push({ idempotencyKey: "k-a", candidateId: "C" });
  assert.throws(() => assertNoNewKeyConflicts(legacy, splitBusinessState(third)), /BUSINESS_MUTATION_IDEMPOTENCY_CONFLICT/u);
});

test("位置分配：往后的比现有都大，往前的比现有都小且从小到大", async () => {
  const allocator = createIndexPositionAllocator(splitBusinessState(storedDocument()));
  assert.deepEqual(await allocator.end(2), [4, 5]);
  assert.deepEqual(await allocator.front(3), [-3, -2, -1]);
  assert.deepEqual(await allocator.front(1), [-4]);
  assert.equal(longestPartitionedCollection(storedDocument()), 4);
  assert.equal(longestPartitionedCollection({ meta: {} }), 0);
});

test("读回来的行格式不对就拒绝", () => {
  const split = splitBusinessState(storedDocument());
  const shared = encodeSharedPart(split.shared);
  const part = encodeCandidatePart(split.parts.get("A"));
  const invalid = /BUSINESS_STATE_REPOSITORY_DOCUMENT_INVALID/u;

  assert.throws(() => decodeSharedPart({ ...shared, schemaVersion: "other" }), invalid);
  assert.throws(() => decodeSharedPart({ ...shared, extra: true }), invalid);
  assert.throws(() => decodeSharedPart({ ...shared, positions: { ...shared.positions, unknown: [] } }), invalid);
  assert.throws(() => decodeSharedPart({ ...shared, positions: { ...shared.positions, dispatches: [1.5] } }), invalid);
  assert.throws(() => decodeSharedPart(null), invalid);

  assert.throws(() => decodeCandidatePart(part, "B"), invalid, "行里的商品编号和行的主键不一致");
  assert.throws(() => decodeCandidatePart({ ...part, collections: { dispatches: { positions: [], records: [] } } }, "A"), invalid);
  assert.throws(() => decodeCandidatePart({ ...part, collections: { dispatches: { positions: [1], records: [{}, {}] } } }, "A"), invalid);
  assert.throws(() => decodeCandidatePart({ ...part, collections: { unknown: { positions: [1], records: [{}] } } }, "A"), invalid);

  assert.throws(() => assembleBusinessState({ document: { dispatches: [{ id: "d" }] }, positions: {} }, []),
    /BUSINESS_STATE_PARTITION_POSITIONS_INVALID:dispatches/u);
  assert.throws(() => assembleBusinessState({ document: { dispatches: "坏的" }, positions: {} },
    [{ candidateId: "A", collections: { dispatches: { positions: [1], records: [{ id: "d", candidateId: "A" }] } } }]),
  /BUSINESS_STATE_PARTITION_SHAPE_INVALID:dispatches/u);
});
