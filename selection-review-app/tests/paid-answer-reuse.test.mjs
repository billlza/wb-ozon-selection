import assert from "node:assert/strict";
import test from "node:test";

import { createPaidAnswerReuse, PAID_ANSWER_REUSE_MS } from "../lib/paid-answer-reuse.mjs";

test("one paid answer per key: a second ask while it runs or soon after pays nothing; a failure is not kept", async () => {
  let at = 0;
  let asks = 0;
  let release;
  const reuse = createPaidAnswerReuse({ nowMs: () => at });
  const ask = () => { asks += 1; return new Promise(resolve => { release = () => resolve(`answer ${asks}`); }); };
  const first = reuse.once("C-1:7", ask);
  const second = reuse.once("C-1:7", ask);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await first, { value: "answer 1", reused: false });
  assert.deepEqual(await second, { value: "answer 1", reused: true });
  at = PAID_ANSWER_REUSE_MS - 1;
  assert.deepEqual(await reuse.once("C-1:7", ask), { value: "answer 1", reused: true });
  assert.equal(asks, 1);
  // Another product version is another question.
  const other = reuse.once("C-1:8", ask);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await other, { value: "answer 2", reused: false });
  // After the reuse window the same version is asked again.
  at = PAID_ANSWER_REUSE_MS * 3;
  const later = reuse.once("C-1:7", ask);
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await later, { value: "answer 3", reused: false });

  const failing = createPaidAnswerReuse();
  await assert.rejects(failing.once("C-2:1", async () => { throw new Error("GATEWAY_DOWN"); }), /GATEWAY_DOWN/);
  assert.deepEqual(await failing.once("C-2:1", async () => "fine"), { value: "fine", reused: false });
});

test("only a bounded number of answers are kept, and bad input is refused", async () => {
  const reuse = createPaidAnswerReuse({ maxEntries: 2 });
  for (const key of ["a", "b", "c"]) await reuse.once(key, async () => key);
  assert.equal(reuse.size, 2);
  assert.deepEqual(await reuse.once("a", async () => "again"), { value: "again", reused: false }, "the oldest one was let go");
  assert.throws(() => reuse.once("", async () => 1), /PAID_ANSWER_REUSE_INPUT_INVALID/);
  assert.throws(() => reuse.once("k", null), /PAID_ANSWER_REUSE_INPUT_INVALID/);
  assert.throws(() => createPaidAnswerReuse({ ttlMs: 0 }), /PAID_ANSWER_REUSE_CONFIGURATION_INVALID/);
});
