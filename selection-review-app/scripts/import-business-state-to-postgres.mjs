import path from "node:path";
import { importBusinessStateToPostgres } from "../lib/business-state-import.mjs";
import { createPostgresBusinessStateStore, isPostgresConnectionString } from "../lib/postgres-business-state-store.mjs";

// Dry run by default: validates the file and looks at the target, writes nothing. `--write` imports into an empty
// target only. The database address comes from SELECTION_REVIEW_DATABASE_URL and is never printed.
const args = process.argv.slice(2);
const write = args.at(-1) === "--write";
const rest = write ? args.slice(0, -1) : args;
if (rest.length !== 2 || rest[0] !== "--from" || !path.isAbsolute(rest[1])) {
  throw new Error("Usage: SELECTION_REVIEW_DATABASE_URL=… import-business-state-to-postgres.mjs --from /absolute/candidates.json [--write]");
}
const connectionString = String(process.env.SELECTION_REVIEW_DATABASE_URL ?? "").trim();
if (!isPostgresConnectionString(connectionString)) throw new Error("SELECTION_REVIEW_DATABASE_URL_REQUIRED");

const store = createPostgresBusinessStateStore({ connectionString, maxConnections: 1 });
try {
  const receipt = await importBusinessStateToPostgres({ sourceFile: rest[1], store, write });
  console.log(JSON.stringify(receipt, null, 2));
  if (receipt.status === "target_not_empty") process.exitCode = 2;
} finally {
  await store.close();
}
