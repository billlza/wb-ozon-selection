import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSelfContainedTestSource,assertIsolatedApiTestSource } from "./ci-test-policy.mjs";
import { API_PROCESS_TESTS, SOURCE_CONTRACT_TESTS, SUBPROCESS_TESTS, ISOLATED_TESTS } from "./ci-test-suites.mjs";

const appDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const testsDirectory = path.join(appDirectory, "tests");

const apiProcessTests = new Set(API_PROCESS_TESTS);
const isolatedTests = new Set(ISOLATED_TESTS);
const concurrency = Number(process.env.SELECTION_REVIEW_TEST_CONCURRENCY ?? '2');
if(!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('CI_TEST_CONCURRENCY_INVALID');

const temporaryCandidateFixtureTests = new Set([
  "atomic-json-persistence.test.mjs",
  "business-state-repository.test.mjs",
]);

function assert(condition, code) {
  if (!condition) {
    throw new Error(code);
  }
}

function assertDisjoint(left, right, code) {
  for (const file of left) {
    assert(!right.has(file), `${code}:${file}`);
  }
}

const testDirectoryEntries = await readdir(testsDirectory, { withFileTypes: true });

for (const entry of testDirectoryEntries) {
  if (!entry.name.endsWith(".test.mjs")) {
    continue;
  }

  assert(entry.isFile(), `CI_TEST_FILE_TYPE_INVALID:${entry.name}`);
  assert(
    /^[A-Za-z0-9][A-Za-z0-9-]*\.test\.mjs$/u.test(entry.name),
    `CI_TEST_FILE_NAME_INVALID:${entry.name}`,
  );
}

const testFiles = testDirectoryEntries
  .map((entry) => entry.name)
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();
const knownTests = new Set(testFiles);

assert(isolatedTests.size === ISOLATED_TESTS.length, "CI_TEST_CLASSIFICATION_OVERLAP");
assertDisjoint(isolatedTests, temporaryCandidateFixtureTests, "CI_TEST_CLASSIFICATION_OVERLAP");

for (const file of [
  ...isolatedTests,
  ...temporaryCandidateFixtureTests,
]) {
  assert(knownTests.has(file), `CI_TEST_CLASSIFICATION_FILE_MISSING:${file}`);
}

for (const file of SOURCE_CONTRACT_TESTS) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assert(source.includes("readFile") || source.includes("server.mjs"), `CI_SOURCE_CONTRACT_MARKER_MISSING:${file}`);
}
for (const file of SUBPROCESS_TESTS) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assert(source.includes("node:child_process"), `CI_SUBPROCESS_MARKER_MISSING:${file}`);
}

const sharedFixtureSource=await readFile(path.join(testsDirectory,'helpers','d-e-saved-api-fixture.mjs'),'utf8');
const launchScriptSource=await readFile(path.join(appDirectory,'scripts','launch-server.sh'),'utf8');
for (const file of apiProcessTests) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assertIsolatedApiTestSource({file,source,sharedFixtureSource,launchScriptSource});
}

for (const file of temporaryCandidateFixtureTests) {
  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assert(source.includes("mkdtemp"), `CI_TEMP_FIXTURE_BOUNDARY_MISSING:${file}`);
  assert(source.includes("candidates.json"), `CI_TEMP_FIXTURE_MARKER_MISSING:${file}`);
}

const selectedTests = [];
for (const file of testFiles) {
  if (isolatedTests.has(file)) {
    continue;
  }

  const source = await readFile(path.join(testsDirectory, file), "utf8");
  assertSelfContainedTestSource({
    file,
    source,
    allowTemporaryCandidateFixture: temporaryCandidateFixtureTests.has(file),
  });

  selectedTests.push(path.join("tests", file));
}

assert(selectedTests.length > 0, "CI_SELF_CONTAINED_TESTS_EMPTY");

console.log(
  `Running ${selectedTests.length} self-contained test files; `
    + `excluding ${isolatedTests.size} files executed by the isolated runner.`,
);

const result = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...selectedTests], {
  cwd: appDirectory,
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
