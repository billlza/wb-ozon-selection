import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { createJsonBusinessStateRepository, createMemoryBusinessStateRepository } from "./business-state-repository.mjs";

/**
 * Copies one candidates.json into an empty Postgres store, unchanged. The file is validated the way the JSON adapter
 * reads it; without `write` nothing is written (not even the table). With `write`, the row is inserted only when the
 * target is empty, read back inside the same transaction and compared with the file before commit.
 */
export async function importBusinessStateToPostgres({ sourceFile, store, write = false, readSource = file => readFile(file, "utf8") } = {}) {
  if (typeof sourceFile !== "string" || !sourceFile) throw new Error("BUSINESS_STATE_IMPORT_SOURCE_REQUIRED");
  if (!store || typeof store.inspect !== "function" || typeof store.insertDocument !== "function") {
    throw new Error("BUSINESS_STATE_IMPORT_STORE_REQUIRED");
  }
  const sourceText = await readSource(sourceFile);
  const expected = await createJsonBusinessStateRepository({ filePath: sourceFile,
    fileSystem: { readFile: async () => sourceText } }).readSnapshot();
  if (expected.meta?.version !== 2 || !Array.isArray(expected.candidates)) throw new Error("BUSINESS_STATE_IMPORT_SOURCE_INVALID");
  const summary = {
    candidates: expected.candidates.length,
    dispatches: Array.isArray(expected.dispatches) ? expected.dispatches.length : 0,
    sourceBytes: Buffer.byteLength(sourceText, "utf8")
  };
  const target = await store.inspect();
  if (target.revision !== null) return { status: "target_not_empty", written: false, targetRevision: target.revision, ...summary };
  if (!write) return { status: "dry_run_ready", written: false, tableExists: target.tableExists, ...summary };
  const inserted = await store.insertDocument(JSON.parse(sourceText), {
    verify: async stored => {
      const readBack = await createMemoryBusinessStateRepository(stored).readSnapshot();
      if (!isDeepStrictEqual(readBack, expected)) throw new Error("BUSINESS_STATE_IMPORT_READBACK_MISMATCH");
    }
  });
  if (!inserted) return { status: "target_not_empty", written: false, ...summary };
  return { status: "imported", written: true, ...summary };
}
