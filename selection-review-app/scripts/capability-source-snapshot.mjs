import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CAPABILITY_ARTIFACT_SCAN_POLICY,
  CAPABILITY_ARTIFACT_ASSIGNMENTS,
  CAPABILITY_NODES,
  CAPABILITY_OVERLAP_GROUPS,
  CAPABILITY_REGISTRY_VERSION,
  CAPABILITY_SNAPSHOT_VERSION,
  UNPLACED_CAPABILITIES,
  assertCapabilityRegistryIntegrity,
  registeredArtifactPaths
} from "../lib/capability-registry.mjs";
import { persistJsonThroughRealTarget } from "../lib/atomic-json-persistence.mjs";

const { lstat, readFile, readdir } = fs;

export const HISTORICAL_SNAPSHOT_PATH = "capability-snapshots/three-store-capability-snapshot-v1.json";
export const CURRENT_SNAPSHOT_PATH = "capability-snapshots/three-store-capability-snapshot-v2.json";
// Independently compared with the preserved historical source. This checksum
// detects accidental history edits; it is not an authenticity mechanism.
export const HISTORICAL_SNAPSHOT_SHA256 = "e3ced8107d2fc4306cfcfd33c92e5bc5987d65b3c78b4c02e9ef23ccfd0f85ff";

export function excludedArtifactPath(relativePath) {
  if(relativePath.startsWith('lib/batch-catalogs/'))return true;
  const parts = relativePath.split("/");
  const directories = new Set([".git", "node_modules", "dist", "coverage", "output", "cache", "logs", "evidence", "data", "docs", "capability-snapshots"]);
  return parts.some(part => directories.has(part) || part.startsWith(".vite") || part === ".DS_Store" || part.startsWith(".env")) ||
    /\.(?:md|png|jpg|jpeg|webp|log|pem|p12|key)$/i.test(relativePath) ||
    /(?:^|\/)(?:credentials?|tokens?|cookies?|secrets?)\.(?:json|toml|yaml|yml)$/i.test(relativePath);
}

function sourcePath(appDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath) ||
      relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`CAPABILITY_SOURCE_PATH_INVALID:${relativePath}`);
  }
  return path.join(appDir, relativePath);
}

async function sourceMetadata(appDir, relativePath) {
  sourcePath(appDir, relativePath);
  let metadata;
  const parts = relativePath.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const prefix = parts.slice(0, index).join("/");
    metadata = await lstat(sourcePath(appDir, prefix));
    if (metadata.isSymbolicLink()) throw new Error(`CAPABILITY_SOURCE_SYMLINK:${prefix}`);
  }
  return metadata;
}

async function walkFiles(appDir, relativeDirectory) {
  const metadata = await sourceMetadata(appDir, relativeDirectory);
  if (!metadata.isDirectory()) throw new Error(`CAPABILITY_SOURCE_DIRECTORY_REQUIRED:${relativeDirectory}`);
  const entries = await readdir(sourcePath(appDir, relativeDirectory), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (excludedArtifactPath(relativePath)) continue;
    const child = await sourceMetadata(appDir, relativePath);
    if (child.isDirectory()) files.push(...await walkFiles(appDir, relativePath));
    else if (child.isFile()) files.push(relativePath);
    else throw new Error(`CAPABILITY_SOURCE_FILE_REQUIRED:${relativePath}`);
  }
  return files;
}

export async function eligibleArtifactPaths(appDir) {
  const paths = [];
  for (const relativePath of CAPABILITY_ARTIFACT_SCAN_POLICY.rootFiles) {
    const metadata = await sourceMetadata(appDir, relativePath);
    if (!metadata.isFile()) throw new Error(`CAPABILITY_SOURCE_FILE_REQUIRED:${relativePath}`);
    paths.push(relativePath);
  }
  for (const directory of CAPABILITY_ARTIFACT_SCAN_POLICY.includedDirectories) paths.push(...await walkFiles(appDir, directory));
  return [...new Set(paths)].sort();
}

export async function sourceBaseline(appDir, paths) {
  const files = [];
  for (const relativePath of paths) {
    if (excludedArtifactPath(relativePath)) throw new Error(`CAPABILITY_SOURCE_EXCLUDED:${relativePath}`);
    const metadata = await sourceMetadata(appDir, relativePath);
    if (!metadata.isFile()) throw new Error(`CAPABILITY_SOURCE_FILE_REQUIRED:${relativePath}`);
    const bytes = await readFile(sourcePath(appDir, relativePath));
    files.push({ path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const digest = createHash("sha256").update(files.map(entry => `${entry.path}\0${entry.sha256}\n`).join("")).digest("hex");
  return { digest, files };
}

async function snapshotPath(appDir, relativePath, { allowMissing = false, createDirectory = false } = {}) {
  const directory = path.dirname(relativePath);
  if (createDirectory) await fs.mkdir(sourcePath(appDir, directory), { recursive: true });
  const metadata = await sourceMetadata(appDir, directory);
  if (!metadata.isDirectory()) throw new Error("CAPABILITY_SNAPSHOT_DIRECTORY_REQUIRED");
  try {
    const target = await sourceMetadata(appDir, relativePath);
    if (!target.isFile()) throw new Error("CAPABILITY_SNAPSHOT_FILE_REQUIRED");
  } catch (error) {
    if (!(allowMissing && error.code === "ENOENT")) throw error;
  }
  return sourcePath(appDir, relativePath);
}

export async function readCapabilitySnapshot(appDir, relativePath) {
  if (![CURRENT_SNAPSHOT_PATH, HISTORICAL_SNAPSHOT_PATH].includes(relativePath)) throw new Error("CAPABILITY_SNAPSHOT_PATH_INVALID");
  return readFile(await snapshotPath(appDir, relativePath));
}

export async function writeCapabilitySnapshot(appDir, snapshot, { fileSystem = fs } = {}) {
  if (snapshot.snapshotVersion !== CAPABILITY_SNAPSHOT_VERSION) throw new Error("CAPABILITY_SNAPSHOT_VERSION_INVALID");
  const target = await snapshotPath(appDir, CURRENT_SNAPSHOT_PATH, { allowMissing: true, createDirectory: true });
  await persistJsonThroughRealTarget(target, snapshot, { fileSystem });
}

export function registryReferences() {
  return [
    ...CAPABILITY_NODES.flatMap(node => [...node.codeRefs, ...node.uiRefs, ...node.testRefs].map(ref => ({ ownerId: node.id, ...ref }))),
    ...UNPLACED_CAPABILITIES.flatMap(item => item.evidenceRefs.map(ref => ({ ownerId: item.id, ...ref })))
  ];
}

export async function buildCapabilitySourceSnapshot(appDir, frozenAt) {
  assertCapabilityRegistryIntegrity();
  if (!Number.isFinite(Date.parse(frozenAt))) throw new Error("CAPABILITY_SNAPSHOT_TIME_INVALID");
  const eligible = await eligibleArtifactPaths(appDir);
  const registered = new Set(registeredArtifactPaths());
  const missing = eligible.filter(file => !registered.has(file));
  const stale = [...registered].filter(file => file !== "data/workflow-map.json" && !eligible.includes(file));
  if (missing.length || stale.length) throw new Error(`CAPABILITY_SOURCE_COVERAGE_INVALID:${JSON.stringify({ missing, stale })}`);
  for (const reference of registryReferences()) {
    const source = await readFile(sourcePath(appDir, reference.path), "utf8");
    if (!source.includes(reference.anchor)) throw new Error(`CAPABILITY_SOURCE_ANCHOR_MISSING:${reference.ownerId}:${reference.path}#${reference.anchor}`);
  }
  const baseline = await sourceBaseline(appDir, eligible);
  const historicalBytes = await readCapabilitySnapshot(appDir, HISTORICAL_SNAPSHOT_PATH);
  const historicalDigest = createHash("sha256").update(historicalBytes).digest("hex");
  if (historicalDigest !== HISTORICAL_SNAPSHOT_SHA256) throw new Error("CAPABILITY_HISTORY_CHANGED");
  const historical = JSON.parse(historicalBytes);
  if (historical.snapshotVersion !== "three-store-capability-snapshot-v1") throw new Error("CAPABILITY_HISTORY_VERSION_INVALID");
  const presentFiles = files => [...new Set(files)].sort().map(file => ({ path: file, status: eligible.includes(file) ? "present_in_integration_source" : "excluded_dynamic_data" }));
  return {
    snapshotVersion: CAPABILITY_SNAPSHOT_VERSION,
    registryVersion: CAPABILITY_REGISTRY_VERSION,
    frozenAt,
    purpose: "当前集成源码、归属及锚点的只读快照；历史观察单独保留，不代表当前运行或平台完成。",
    numbering: { frozen: true, retiredIdsMayBeReused: false },
    historicalSnapshot: {
      path: HISTORICAL_SNAPSHOT_PATH, frozenAt: historical.frozenAt,
      sha256: historicalDigest,
      interpretation: "historical_only_not_current_runtime_evidence"
    },
    sourceBaselines: {
      integration: { status: "inspected", artifactCount: eligible.length, sha256: baseline.digest, digestPurpose: "detect accidental source drift" },
      main: { status: "not_inspected_this_snapshot" },
      oldWorktree: { status: "not_inspected_this_snapshot" },
      runningCopy: { status: "not_inspected_this_snapshot" }
    },
    artifactCoverage: { unexplainedCount: missing.length, staleCount: stale.length, files: baseline.files },
    capabilities: CAPABILITY_NODES.map(node => ({
      id: node.id, wiringStatus: node.wiringStatus, verificationStatus: node.verificationStatus,
      artifacts: presentFiles([...node.codeRefs, ...node.uiRefs, ...node.testRefs].map(ref => ref.path).concat(node.artifactRefs)),
      realExecutionEvidence: "not_inspected_this_snapshot"
    })),
    unplacedCapabilities: UNPLACED_CAPABILITIES.map(item => ({
      id: item.id, artifacts: presentFiles(item.evidenceRefs.map(ref => ref.path).concat(item.artifactRefs)),
      historicalArtifactRefs: item.historicalArtifactRefs ?? []
    })),
    overlapGroups: CAPABILITY_OVERLAP_GROUPS.map(group => ({ id: group.id, artifacts: presentFiles(group.members.flatMap(member => [member.path, ...member.testRefs])) })),
    assignmentGroups: CAPABILITY_ARTIFACT_ASSIGNMENTS.map(group => ({ id: group.id, ownerIds: [...group.ownerIds], paths: [...group.paths] })),
    intentDocumentsUsed: false, externalPlatformsAccessed: false, businessStateModified: false, runtimeCopyModified: false, deployed: false
  };
}

export async function checkCapabilitySourceSnapshot(appDir) {
  const existing = (await readCapabilitySnapshot(appDir, CURRENT_SNAPSHOT_PATH)).toString("utf8");
  const snapshot = await buildCapabilitySourceSnapshot(appDir, JSON.parse(existing).frozenAt);
  if (`${JSON.stringify(snapshot, null, 2)}\n` !== existing) {
    throw new Error("CAPABILITY_SNAPSHOT_DRIFT: regenerate after reviewing source changes");
  }
  return snapshot;
}
