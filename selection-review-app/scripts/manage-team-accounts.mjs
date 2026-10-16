import { OwnerIdentityError } from "../lib/local-owner-identity.mjs";
import { isPostgresConnectionString } from "../lib/postgres-business-state-store.mjs";
import { runTeamAccountCommand, TeamAccountCommandError } from "../lib/team-account-admin.mjs";
import { createPostgresTeamAccountStore, TeamAccountStoreError } from "../lib/team-account-store.mjs";

// Team accounts: list, add, reset a password, disable, enable, or import the owner's password from the Mac.
// The database address comes from SELECTION_REVIEW_DATABASE_URL and is never printed. Passwords are typed with the
// echo off; piped in, the first line is the password.
const connectionString = String(process.env.SELECTION_REVIEW_DATABASE_URL ?? "").trim();
if (!isPostgresConnectionString(connectionString)) throw new Error("SELECTION_REVIEW_DATABASE_URL_REQUIRED");

let pipedLines = null;
async function readPassword(prompt) {
  if (!process.stdin.isTTY) {
    if (pipedLines !== null) return null;
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    pipedLines = text.split(/\r?\n/u);
    return pipedLines[0];
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(value);
    };
    function onData(chunk) {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish(new TeamAccountCommandError("已取消，什么都没改"));
        if (character === "\u007f" || character === "\b") value = [...value].slice(0, -1).join("");
        else value += character;
      }
    }
    process.stdin.on("data", onData);
  });
}

const store = createPostgresTeamAccountStore({ connectionString, maxConnections: 1 });
try {
  await runTeamAccountCommand({ args: process.argv.slice(2), store, readPassword,
    print: value => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2)) });
} catch (error) {
  // Only our own messages or a code: a driver message can carry the database host.
  if (error instanceof TeamAccountCommandError || error instanceof OwnerIdentityError) console.error(error.message);
  else console.error(`没有完成：${error instanceof TeamAccountStoreError ? error.code : error?.code ?? error?.name ?? "unknown"}`);
  process.exitCode = 2;
} finally {
  await store.close();
}
