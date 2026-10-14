import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareRuntimePackage, RUNTIME_PACKAGE_FILES, RUNTIME_PACKAGE_DIRECTORIES } from "../scripts/runtime-package.mjs";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const manifest = { name: "selection-review-app", type: "module", dependencies: { "ali-oss": "6.23.0", sharp: "0.35.4" } };

async function syntheticSource(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "runtime-package-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, "source");
  const outputDirectory = path.join(root, "package");
  await fs.mkdir(sourceDirectory);
  for (const directory of [...RUNTIME_PACKAGE_DIRECTORIES, "scripts", "node_modules/.store", "data", "config"]) {
    await fs.mkdir(path.join(sourceDirectory, directory), { recursive: true });
  }
  for (const file of RUNTIME_PACKAGE_FILES) await fs.writeFile(path.join(sourceDirectory, file), "// synthetic code only\n");
  await fs.writeFile(path.join(sourceDirectory, "package.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(sourceDirectory, "dist/index.html"), "<!doctype html><title>Synthetic build</title>");
  await fs.writeFile(path.join(sourceDirectory, "lib/module.mjs"), "export const fixture = true;\n");
  await fs.writeFile(path.join(sourceDirectory, "schema/example.json"), "{}");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const directory = path.join(sourceDirectory, "node_modules/.store", name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version, main: "index.js" }));
    await fs.writeFile(path.join(directory, "index.js"), "module.exports = function syntheticDependency() {};\n");
    await fs.symlink(`.store/${name}`, path.join(sourceDirectory, "node_modules", name));
  }
  const nodeExecutable = path.join(root, "synthetic-node");
  await fs.writeFile(nodeExecutable, "#!/bin/sh\nexit 91\n", { mode: 0o755 });
  await fs.writeFile(path.join(sourceDirectory, "data/candidates.json"), "synthetic persistent candidate sentinel");
  await fs.writeFile(path.join(sourceDirectory, "config/runtime.json"), "synthetic private configuration sentinel");
  await fs.writeFile(path.join(sourceDirectory, ".env"), "SYNTHETIC_PRIVATE_SENTINEL=not-a-credential");
  return { root, sourceDirectory, outputDirectory, nodeExecutable };
}

async function assertNoOutputOrStaging(fixture) {
  await assert.rejects(fs.lstat(fixture.outputDirectory), { code: "ENOENT" });
  assert.equal((await fs.readdir(fixture.root)).some(name => name.includes(".preparing-")), false);
}

test("prepare produces only the complete code package and leaves persistent content unchanged", async t => {
  const fixture = await syntheticSource(t);
  const receipt = await prepareRuntimePackage(fixture);
  assert.deepEqual((await fs.readdir(fixture.outputDirectory)).sort(), ["dist", "docs", "lib", "node_modules", "package.json", "runtime", "runtime-package.json", "schema", "scripts", "server.mjs", "启动今日选品评审台.command"].sort());
  assert.deepEqual(receipt.dependencyVersions, manifest.dependencies);
  assert.deepEqual(await fs.readlink(path.join(fixture.outputDirectory, "node_modules/ali-oss")), ".store/ali-oss");
  assert.equal(await fs.readFile(path.join(fixture.sourceDirectory, "data/candidates.json"), "utf8"), "synthetic persistent candidate sentinel");
  assert.equal(await fs.readFile(path.join(fixture.sourceDirectory, "config/runtime.json"), "utf8"), "synthetic private configuration sentinel");
  for (const key of ["persistentContentIncluded", "installed", "activated", "startupVerified"]) assert.equal(receipt[key], false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.outputDirectory, "runtime-package.json"), "utf8")), receipt);
});

test("existing output, including persistent content, cannot be replaced", async t => {
  const fixture = await syntheticSource(t);
  await fs.mkdir(fixture.outputDirectory);
  await fs.writeFile(path.join(fixture.outputDirectory, "candidates.json"), "existing synthetic state");
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_OUTPUT_EXISTS" });
  assert.equal(await fs.readFile(path.join(fixture.outputDirectory, "candidates.json"), "utf8"), "existing synthetic state");
  assert.deepEqual(await fs.readdir(fixture.outputDirectory), ["candidates.json"]);
});

test("relative paths and output inside the source tree are rejected", async t => {
  const fixture = await syntheticSource(t);
  await assert.rejects(prepareRuntimePackage({ ...fixture, outputDirectory: "relative-output" }), { code: "RUNTIME_PACKAGE_ABSOLUTE_PATH_REQUIRED" });
  await assert.rejects(prepareRuntimePackage({ ...fixture, outputDirectory: path.join(fixture.sourceDirectory, "package") }), { code: "RUNTIME_PACKAGE_OUTPUT_OVERLAPS_SOURCE" });
  await assertNoOutputOrStaging(fixture);
});

for (const input of ["dist", "dist/index.html", "server.mjs", "scripts/launch-server.sh"]) {
  test(`missing required input ${input} fails before publishing`, async t => {
    const fixture = await syntheticSource(t);
    await fs.rm(path.join(fixture.sourceDirectory, input), { recursive: true });
    await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_INPUT_MISSING" });
    await assertNoOutputOrStaging(fixture);
  });
}

test("missing dependency removes partial staging and does not use a parent's dependency", async t => {
  const fixture = await syntheticSource(t);
  await fs.unlink(path.join(fixture.sourceDirectory, "node_modules/ali-oss"));
  // A module is deliberately available above the output. Resolution must reject it.
  await fs.mkdir(path.join(fixture.root, "node_modules/ali-oss"), { recursive: true });
  await fs.writeFile(path.join(fixture.root, "node_modules/ali-oss/index.js"), "module.exports = {};\n");
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_DEPENDENCY_OUTSIDE" });
  await assertNoOutputOrStaging(fixture);
});

test("missing dependency tree and wrong pinned versions fail explicitly", async t => {
  const fixture = await syntheticSource(t);
  await fs.writeFile(path.join(fixture.sourceDirectory, "node_modules/.store/ali-oss/package.json"), JSON.stringify({ name: "ali-oss", version: "0.0.0", main: "index.js" }));
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_DEPENDENCY_VERSION_MISMATCH" });
  await assertNoOutputOrStaging(fixture);
  await fs.rm(path.join(fixture.sourceDirectory, "node_modules"), { recursive: true });
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_DEPENDENCY_MISSING" });
});

for (const kind of ["absolute", "relative", "broken", "cycle"]) {
  test(`dependency ${kind} link is rejected without reading external content`, async t => {
    const fixture = await syntheticSource(t);
    const link = path.join(fixture.sourceDirectory, "node_modules/bad");
    const target = kind === "absolute" ? fixture.nodeExecutable : kind === "relative" ? "../../synthetic-node" : kind === "cycle" ? "bad" : "missing";
    await fs.symlink(target, link);
    await assert.rejects(prepareRuntimePackage(fixture), { code: ["absolute", "relative"].includes(kind) ? "RUNTIME_PACKAGE_DEPENDENCY_LINK_OUTSIDE" : "RUNTIME_PACKAGE_DEPENDENCY_LINK_INVALID" });
    await assertNoOutputOrStaging(fixture);
  });
}

test("first-party links, private files and output links cannot redirect preparation", async t => {
  const fixture = await syntheticSource(t);
  const sourceLink = path.join(fixture.sourceDirectory, "lib/link.mjs");
  await fs.symlink(fixture.nodeExecutable, sourceLink);
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_SOURCE_SYMLINK" });
  await fs.unlink(sourceLink);
  const privateFile = path.join(fixture.sourceDirectory, "lib/.env.local");
  await fs.writeFile(privateFile, "synthetic private sentinel");
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_PRIVATE_FILE" });
  await fs.unlink(privateFile);
  await fs.symlink(fixture.sourceDirectory, fixture.outputDirectory);
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_OUTPUT_EXISTS" });
  assert.equal(await fs.readlink(fixture.outputDirectory), fixture.sourceDirectory);
});

test("a linked launcher directory is rejected before copying its target", async t => {
  const fixture = await syntheticSource(t);
  const scripts = path.join(fixture.sourceDirectory, "scripts");
  const outside = path.join(fixture.root, "outside-scripts");
  await fs.rename(scripts, outside);
  await fs.symlink(outside, scripts);
  await assert.rejects(prepareRuntimePackage(fixture), { code: "RUNTIME_PACKAGE_INPUT_TYPE_INVALID" });
  await assertNoOutputOrStaging(fixture);
});

test("concurrent preparation publishes one complete package and removes the losing staging", async t => {
  const fixture = await syntheticSource(t);
  const results = await Promise.allSettled([prepareRuntimePackage(fixture), prepareRuntimePackage(fixture)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "RUNTIME_PACKAGE_OUTPUT_EXISTS");
  assert.equal((await fs.readdir(fixture.root)).some(name => name.includes(".preparing-")), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.outputDirectory, "runtime-package.json"), "utf8")).status, "prepared");
});

test("preparation entry requires explicit parameters and only builds the synthetic source", { timeout: 30000 }, async t => {
  const fixture = await syntheticSource(t);
  for (const script of ["runtime-package.mjs", "prepare-local-runtime.mjs", "deploy-local-runtime.sh"]) {
    await fs.copyFile(path.join(appDirectory, "scripts", script), path.join(fixture.sourceDirectory, "scripts", script));
  }
  const entry = path.join(fixture.sourceDirectory, "scripts/deploy-local-runtime.sh");
  const env = { PATH: "/usr/bin:/bin", HOME: fixture.root, TMPDIR: fixture.root, SELECTION_REVIEW_BUILD_NODE: process.execPath };
  await assert.rejects(execFileAsync("/bin/bash", [entry], { env, timeout: 5000 }), { code: 64 });
  await assertNoOutputOrStaging(fixture);
  const { stdout } = await execFileAsync("/bin/bash", [entry, "--prepare-only", "--output", fixture.outputDirectory], { env, timeout: 25000 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.installed, false);
  assert.equal(receipt.activated, false);
  assert.equal(receipt.startupVerified, false);
});

test("copied ali-oss and native sharp load from the package after its source is removed", { timeout: 60000 }, async t => {
  const fixture = await syntheticSource(t);
  await fs.copyFile(path.join(appDirectory, "package.json"), path.join(fixture.sourceDirectory, "package.json"));
  await fs.rm(path.join(fixture.sourceDirectory, "node_modules"), { recursive: true });
  // Only the installed source dependency tree is read; no source data/config or server is used.
  await fs.symlink(await fs.realpath(path.join(appDirectory, "node_modules")), path.join(fixture.sourceDirectory, "node_modules"));
  await prepareRuntimePackage({ ...fixture, nodeExecutable: process.execPath });
  await fs.rm(fixture.sourceDirectory, { recursive: true });
  const script = 'const fs=require("node:fs"),path=require("node:path");for(const name of ["ali-oss","sharp"]){const resolved=fs.realpathSync(require.resolve(name));if(!resolved.startsWith(path.join(process.cwd(),"node_modules")+path.sep))throw Error("PACKAGE_DEPENDENCY_OUTSIDE");if(typeof require(name)!=="function")throw Error("PACKAGE_DEPENDENCY_NOT_LOADED")}console.log(JSON.stringify({loaded:["ali-oss","sharp"],sharpVersion:require("sharp").versions.sharp}));';
  const { stdout, stderr } = await execFileAsync(path.join(fixture.outputDirectory, "runtime/node"), ["-e", script], {
    cwd: fixture.outputDirectory, env: { PATH: "/usr/bin:/bin", HOME: fixture.root, TMPDIR: fixture.root }, timeout: 15000
  });
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { loaded: ["ali-oss", "sharp"], sharpVersion: "0.35.4" });
});
