// Stands in for lib/postgres-business-state-store.mjs with one row and no database: the document goes through JSON text
// both ways (the json column keeps the text as written), every write bumps the revision, and locked work runs one at a
// time, the way the row lock orders it.
export function createFakePostgresBusinessStateStore({ document = null } = {}) {
  let row = document === null ? null : { text: JSON.stringify(document), revision: 1 };
  let lock = Promise.resolve();
  const calls = { reads: 0, documentTransfers: 0, writes: 0, inserts: 0 };
  return {
    calls,
    get revision() { return row?.revision ?? null; },
    storedText() { return row?.text ?? null; },
    async readDocument({ knownRevision = null } = {}) {
      calls.reads += 1;
      if (row === null) return null;
      if (String(row.revision) === knownRevision) return { revision: String(row.revision) };
      calls.documentTransfers += 1;
      return { revision: String(row.revision), document: JSON.parse(row.text) };
    },
    runLocked({ initialDocument = null } = {}, work) {
      const run = lock.then(async () => {
        let current = row;
        if (current === null) {
          if (typeof initialDocument !== "function") throw new Error("BUSINESS_STATE_REPOSITORY_DOCUMENT_MISSING");
          current = { text: JSON.stringify(initialDocument()), revision: 1 };
        }
        let replacement = null;
        const result = await work({ document: JSON.parse(current.text), replace(next) { replacement = next; } });
        if (replacement !== null) {
          row = { text: JSON.stringify(replacement), revision: current.revision + 1 };
          calls.writes += 1;
        }
        return result;
      });
      lock = run.then(() => undefined, () => undefined);
      return run;
    },
    async inspect() {
      return { tableExists: row !== null, revision: row === null ? null : String(row.revision) };
    },
    async insertDocument(next, { verify = async () => {} } = {}) {
      if (row !== null) return false;
      const text = JSON.stringify(next);
      await verify(JSON.parse(text));
      row = { text, revision: 1 };
      calls.inserts += 1;
      return true;
    },
    async close() {}
  };
}
