// A paid AI answer that only reads (nothing is saved) is asked once per product version: a double click, a resent
// request, or a second person on the same product within a few minutes gets the same answer without paying again.
// A failed ask is not kept, so the next click asks again. Only one service process works on the data at a time (the
// process lease), so what is kept here is the whole service's.

export const PAID_ANSWER_REUSE_MS = 10 * 60_000;
export const PAID_ANSWER_REUSE_MAX_ENTRIES = 50;

export function createPaidAnswerReuse({ ttlMs = PAID_ANSWER_REUSE_MS, maxEntries = PAID_ANSWER_REUSE_MAX_ENTRIES, nowMs = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || typeof nowMs !== "function") {
    throw new Error("PAID_ANSWER_REUSE_CONFIGURATION_INVALID");
  }
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) {
      if (entry.settledAt !== null && nowMs() - entry.settledAt >= ttlMs) entries.delete(key);
    }
  }
  return Object.freeze({
    /** `{ value, reused }`: `reused` is true when this call paid nothing because another one asked the same. */
    once(key, ask) {
      if (typeof key !== "string" || key === "" || typeof ask !== "function") throw new Error("PAID_ANSWER_REUSE_INPUT_INVALID");
      prune();
      const held = entries.get(key);
      if (held) return held.promise.then(value => ({ value, reused: true }));
      const entry = { promise: Promise.resolve().then(ask), settledAt: null };
      entries.set(key, entry);
      entry.promise.then(() => { entry.settledAt = nowMs(); }, () => { if (entries.get(key) === entry) entries.delete(key); });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return entry.promise.then(value => ({ value, reused: false }));
    },
    get size() { return entries.size; }
  });
}
