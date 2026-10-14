import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const RUNTIME_PACKAGE_FILES = Object.freeze([
  "server.mjs", "package.json", "scripts/launch-server.sh", "启动今日选品评审台.command"
]);
// docs/contracts 是运行期真要读的官方合同证据：lib/ozon-de-protocol-catalog.mjs 在服务启动时就 readFile 它们，
// 漏打包会让新版本根本起不来。r64 是靠手工补拷进去才活着的，这里把它纳入正式包。
export const RUNTIME_PACKAGE_DIRECTORIES = Object.freeze(["lib", "schema", "dist", "docs/contracts"]);
const dependencyName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function failure(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function requireEntry(file, type) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (error.code === "ENOENT") throw failure("RUNTIME_PACKAGE_INPUT_MISSING", { entry: path.basename(file) });
    throw error;
  }
  if (stat.isSymbolicLink() || (type === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw failure("RUNTIME_PACKAGE_INPUT_TYPE_INVALID", { entry: path.basename(file) });
  }
}

async function validateTree(root, directory = root, allowInternalLinks = false) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      if (!allowInternalLinks) throw failure("RUNTIME_PACKAGE_SOURCE_SYMLINK");
      const link = await fs.readlink(file);
      if (path.isAbsolute(link) || !inside(root, path.resolve(directory, link))) {
        throw failure("RUNTIME_PACKAGE_DEPENDENCY_LINK_OUTSIDE");
      }
      let target;
      try { target = await fs.realpath(file); }
      catch (error) {
        if (["ENOENT", "ELOOP"].includes(error.code)) throw failure("RUNTIME_PACKAGE_DEPENDENCY_LINK_INVALID");
        throw error;
      }
      if (!inside(root, target)) throw failure("RUNTIME_PACKAGE_DEPENDENCY_LINK_OUTSIDE");
    } else if (stat.isDirectory()) {
      await validateTree(root, file, allowInternalLinks);
    } else if (!stat.isFile()) {
      throw failure("RUNTIME_PACKAGE_SPECIAL_FILE");
    } else if (!allowInternalLinks && (/^\.env/i.test(entry.name) || /\.(?:pem|key|p12|pfx)$/i.test(entry.name))) {
      throw failure("RUNTIME_PACKAGE_PRIVATE_FILE");
    }
  }
}

async function validateDependencies(root, manifest) {
  if (manifest.name !== "selection-review-app" || manifest.type !== "module" ||
      manifest.dependencies?.["ali-oss"] !== "6.23.0" || manifest.dependencies?.sharp !== "0.35.4") {
    throw failure("RUNTIME_PACKAGE_MANIFEST_INVALID");
  }
  const require = createRequire(path.join(root, "package.json"));
  const versions = {};
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (!dependencyName.test(name)) throw failure("RUNTIME_PACKAGE_DEPENDENCY_NAME_INVALID");
    if (typeof version !== "string" || !version.trim()) throw failure("RUNTIME_PACKAGE_DEPENDENCY_VERSION_INVALID", { name });
    let resolved;
    try { resolved = require.resolve(name); }
    catch (error) {
      if (error.code === "MODULE_NOT_FOUND") throw failure("RUNTIME_PACKAGE_DEPENDENCY_MISSING", { name });
      throw error;
    }
    if (!inside(path.join(root, "node_modules"), await fs.realpath(resolved))) {
      throw failure("RUNTIME_PACKAGE_DEPENDENCY_OUTSIDE", { name });
    }
    const installed = JSON.parse(await fs.readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    if (/^\d+\.\d+\.\d+$/.test(version) && installed.version !== version) {
      throw failure("RUNTIME_PACKAGE_DEPENDENCY_VERSION_MISMATCH", { name });
    }
    versions[name] = installed.version;
  }
  return versions;
}

/** Build a fresh code package. Never read persistent data or activate services. */
export async function prepareRuntimePackage({ sourceDirectory, outputDirectory, nodeExecutable }) {
  if (![sourceDirectory, outputDirectory, nodeExecutable].every(value => typeof value === "string" && path.isAbsolute(value))) {
    throw failure("RUNTIME_PACKAGE_ABSOLUTE_PATH_REQUIRED");
  }
  const source = await fs.realpath(sourceDirectory);
  const output = path.join(await fs.realpath(path.dirname(outputDirectory)), path.basename(outputDirectory));
  if (inside(source, output) || inside(output, source)) throw failure("RUNTIME_PACKAGE_OUTPUT_OVERLAPS_SOURCE");
  if (await exists(output)) throw failure("RUNTIME_PACKAGE_OUTPUT_EXISTS");
  await requireEntry(path.join(source, "scripts"), "directory");
  for (const file of RUNTIME_PACKAGE_FILES) await requireEntry(path.join(source, file), "file");
  for (const directory of RUNTIME_PACKAGE_DIRECTORIES) {
    const input = path.join(source, directory);
    await requireEntry(input, "directory");
    await validateTree(input);
  }
  await requireEntry(path.join(source, "dist", "index.html"), "file");
  await requireEntry(nodeExecutable, "file");
  await fs.access(nodeExecutable, constants.X_OK);
  let dependencies;
  try { dependencies = await fs.realpath(path.join(source, "node_modules")); }
  catch (error) {
    if (error.code === "ENOENT") throw failure("RUNTIME_PACKAGE_DEPENDENCY_MISSING", { name: "node_modules" });
    throw error;
  }
  await requireEntry(dependencies, "directory");
  if (inside(dependencies, output) || inside(output, dependencies)) throw failure("RUNTIME_PACKAGE_OUTPUT_OVERLAPS_DEPENDENCIES");
  await validateTree(dependencies, dependencies, true);
  const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  // Check resolution after copying: parent node_modules cannot supply missing dependencies.
  const staging = await fs.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.preparing-`));
  let published = false;
  try {
    for (const file of RUNTIME_PACKAGE_FILES) {
      const target = path.join(staging, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, file), target, constants.COPYFILE_EXCL);
    }
    for (const directory of RUNTIME_PACKAGE_DIRECTORIES) {
      await fs.cp(path.join(source, directory), path.join(staging, directory), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    await fs.cp(dependencies, path.join(staging, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    await fs.mkdir(path.join(staging, "runtime"));
    await fs.copyFile(nodeExecutable, path.join(staging, "runtime", "node"), constants.COPYFILE_EXCL);
    await fs.chmod(path.join(staging, "runtime", "node"), 0o755);
    await fs.chmod(path.join(staging, "scripts", "launch-server.sh"), 0o755);
    await fs.chmod(path.join(staging, "启动今日选品评审台.command"), 0o755);
    await validateTree(staging, staging, true);
    const dependencyVersions = await validateDependencies(staging, manifest);
    const receipt = {
      formatVersion: "selection-review-runtime-package-v1", status: "prepared",
      dependencyVersions, preparationNodeVersion: process.version, preparationPlatform: process.platform, preparationArchitecture: process.arch,
      persistentContentIncluded: false, installed: false, activated: false, startupVerified: false,
      requiredLaunchEnvironment: ["SELECTION_REVIEW_DATA_FILE", "SELECTION_REVIEW_PORT"],
      persistentConfiguration: "Supply workflow map, store bindings and upload location separately when authorizing installation."
    };
    await fs.writeFile(path.join(staging, "runtime-package.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (await exists(output)) throw failure("RUNTIME_PACKAGE_OUTPUT_EXISTS");
    try { await fs.rename(staging, output); }
    catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error.code)) throw failure("RUNTIME_PACKAGE_OUTPUT_EXISTS");
      throw error;
    }
    published = true;
    return receipt;
  } catch (error) {
    if (!published) {
      try { await fs.rm(staging, { recursive: true, force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "RUNTIME_PACKAGE_PREPARATION_AND_CLEANUP_FAILED"); }
    }
    throw error;
  }
}
