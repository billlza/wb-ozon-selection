import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_TESTS } from "./ci-test-suites.mjs";

// Database tests need a disposable Postgres; CI starts one as a service container. They never run without it: each
// file refuses to start (TEST_REQUIRES_DATABASE) instead of skipping.
if (!/^postgres(?:ql)?:\/\//u.test(process.env.SELECTION_REVIEW_TEST_DATABASE_URL ?? "")) {
  throw new Error("CI_DATABASE_TESTS_REQUIRE_SELECTION_REVIEW_TEST_DATABASE_URL");
}
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
if (DATABASE_TESTS.length === 0 || new Set(DATABASE_TESTS).size !== DATABASE_TESTS.length) throw new Error("CI_TEST_CLASSIFICATION_OVERLAP");
for (const file of DATABASE_TESTS) {
  const location = path.join(appDirectory, "tests", file);
  if (!(await lstat(location)).isFile()) throw new Error(`CI_DATABASE_TEST_FILE_INVALID:${file}`);
  if (!(await readFile(location, "utf8")).includes("TEST_REQUIRES_DATABASE")) throw new Error(`CI_DATABASE_TEST_BOUNDARY_MISSING:${file}`);
}

// A test that starts the server on the database gets its loopback port from here, as the isolated API runner does.
async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return [4317, 4318, 4173, 4319].includes(port) ? reserveLoopbackPort() : port;
}
const apiPort = await reserveLoopbackPort();
// A second service process on the same data (the handoff test) needs its own port.
let secondPort = await reserveLoopbackPort();
while (secondPort === apiPort) secondPort = await reserveLoopbackPort();

console.log(`Running ${DATABASE_TESTS.length} database test files against the disposable Postgres.`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000",
  ...DATABASE_TESTS.map(file => path.join("tests", file))], { cwd: appDirectory, stdio: "inherit",
  env: { ...process.env, SELECTION_REVIEW_TEST_PORT: String(apiPort), SELECTION_REVIEW_TEST_SECOND_PORT: String(secondPort),
    SELECTION_REVIEW_PUBLIC_PORT: String(apiPort) } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
