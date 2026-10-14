import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTION_EXECUTION_BINDING_SCHEMA } from "../lib/production-authorization-preparation.mjs";

import {
  C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS,
  C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS,
  C2_REFERENCE_SEMANTICS,
  LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE,
  C2_REFERENCE_SCHEMA_DEFS
} from "../lib/production-contract-primitives.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.dirname(scriptDirectory);
const schemaFiles = [
  path.join(appDirectory, "schema/c2-asset-lifecycle-v1.1.schema.json"),
  path.join(appDirectory, "schema/c2-software-input-v1.schema.json"),
  path.join(appDirectory, "schema/production-authorization-v1.1.schema.json"),
  path.join(appDirectory, "schema/production-authorization-v1.2.schema.json")
];
const C2_ASSET_LIFECYCLE_SCHEMA_ID = "c2-asset-lifecycle-v1.1";
const C2_SOFTWARE_INPUT_SCHEMA_ID = "c2-software-input-v1";

function clone(value) {
  return structuredClone(value);
}

function generateProductionAuthorizationReferenceSchema(schema) {
  const generated = clone(schema);
  if (!["production-authorization-v1.1", "production-authorization-v1.2"].includes(schema.$id)) {
    throw new Error(`UNSUPPORTED_PRODUCTION_AUTHORIZATION_SCHEMA:${schema.$id}`);
  }
  const currentVersion = schema.$id === "production-authorization-v1.2";
  if (currentVersion) generated.$defs.executionBinding = clone(PRODUCTION_EXECUTION_BINDING_SCHEMA);
  const trie = {};
  const paths = C1_OPAQUE_AUTHORIZATION_ID_SEMANTICS.runtimePaths.filter(segments =>
    segments[0] === "lockedScope" && (currentVersion || !segments.includes("siblingFormalReuseRecord")));
  for (const segments of paths) {
    let node = trie;
    for (const segment of segments) node = node[segment] ??= {};
  }
  const scopedGuard = (node) => Object.keys(node).length === 0
    ? { $ref: "#/$defs/c1OpaqueAuthorizationId" }
    : {
      if: { type: "object" },
      then: {
        type: "object",
        propertyNames: { $ref: "#/$defs/noProductionSecrets/then/propertyNames" },
        properties: Object.fromEntries(Object.entries(node).map(([field, child]) => [field, scopedGuard(child)])),
        additionalProperties: { $ref: "#/$defs/noProductionSecrets" }
      },
      else: { $ref: "#/$defs/noProductionSecrets" }
    };
  generated.$defs.c1OpaqueAuthorizationId = clone(C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS.c1OpaqueAuthorizationId);
  generated.$defs.authorizationSecretGuard = scopedGuard(trie);
  generated.allOf = [{ $ref: "#/$defs/authorizationSecretGuard" }];
  return generated;
}

function replaceReferences(value) {
  if (Array.isArray(value)) {
    value.forEach(replaceReferences);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (value.$ref === "#/$defs/safeFrozenRef") value.$ref = "#/$defs/canonicalFrozenRef";
  if (value.$ref === "#/$defs/httpsAssetRef") value.$ref = "#/$defs/canonicalStableHttpsAssetRef";
  if (["#/$defs/safeReferenceValue", "#/$defs/safeFactReferenceValue"].includes(value.$ref)) {
    value.$ref = "#/$defs/c2SecretCheckedContractString";
  }
  if (value.$ref === "#/$defs/c2ContractString") {
    value.$ref = "#/$defs/c2SecretCheckedContractString";
  }
  for (const child of Object.values(value)) replaceReferences(child);
}

function setSchemaPath(schema, path, replacement) {
  const parent = path.slice(0, -1).reduce((current, key) => current?.[key], schema);
  const finalKey = path.at(-1);
  if (!parent || !Object.hasOwn(parent, finalKey)) {
    throw new Error(`C2_REFERENCE_SCHEMA_SEMANTIC_PATH_MISSING:${path.join(".")}`);
  }
  parent[finalKey] = clone(replacement);
}

function applyExplicitSemanticContracts(schema, semanticKey) {
  // Reference-like field names cannot safely select a value contract: an
  // authorizationRef object contains the one approved opaque authorizationId
  // path, while arbitrary *Ref/*Id fields must not gain that exception. The
  // declared schema paths below remain the sole authority for reference
  // semantics.
  delete schema.$defs.noSensitivePropertyNames?.then?.patternProperties;
  for (const definitionName of ["collectedAsset", "aiDraftAsset"]) {
    const assetRef = schema.$defs?.[definitionName]?.properties?.assetRef;
    if (!assetRef) continue;
    schema.$defs[definitionName].properties.assetRef = { $ref: "#/$defs/analysisAssetRef" };
  }
  const finalAssetRef = schema.$defs?.finalAsset?.properties?.assetRef;
  if (finalAssetRef) {
    schema.$defs.finalAsset.properties.assetRef = {
      oneOf: [
        { $ref: "#/$defs/canonicalStableHttpsAssetRef" },
        { type: "string", pattern: LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE }
      ]
    };
    schema.$defs.finalAsset.allOf = [{
      if: { properties: { assetRef: { type: "string", pattern: LOCAL_FINAL_ASSET_REF_PATTERN_SOURCE } } },
      then: { properties: { stableUrlEvidenceRef: { const: "not_applicable" } } },
      else: { properties: { stableUrlEvidenceRef: { not: { const: "not_applicable" } } } }
    }];
  }
  for (const schemaPath of C2_REFERENCE_SEMANTICS.c1OpaqueAuthorizationId.schemaPaths[semanticKey] || []) {
    setSchemaPath(schema, schemaPath, { $ref: "#/$defs/c1OpaqueAuthorizationId" });
  }
}

function resolveC2ReferenceSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("C2_REFERENCE_SCHEMA_UNSUPPORTED_SCHEMA_ID:missing");
  }
  switch (schema.$id) {
    case C2_ASSET_LIFECYCLE_SCHEMA_ID:
      return {
        semanticKey: "c2AssetLifecycle",
        referenceDefs: C2_ASSET_LIFECYCLE_REFERENCE_SCHEMA_DEFS
      };
    case C2_SOFTWARE_INPUT_SCHEMA_ID:
      return {
        semanticKey: "c2SoftwareInput",
        referenceDefs: C2_REFERENCE_SCHEMA_DEFS
      };
    default:
      throw new Error(`C2_REFERENCE_SCHEMA_UNSUPPORTED_SCHEMA_ID:${String(schema.$id ?? "missing")}`);
  }
}

function schemaObjectsEqual(current, generated) {
  try {
    assert.deepEqual(generated, current);
    return true;
  } catch (error) {
    if (error?.name !== "AssertionError") throw error;
    return false;
  }
}

export function generateC2ReferenceSchema(schema) {
  const generated = clone(schema);
  const { semanticKey, referenceDefs } = resolveC2ReferenceSchema(generated);
  generated.$defs ||= {};
  replaceReferences(generated);
  generated.$defs.canonicalFrozenRef = clone(referenceDefs.canonicalFrozenRef);
  generated.$defs.canonicalStableHttpsAssetRef = clone(referenceDefs.canonicalStableHttpsAssetRef);
  generated.$defs.analysisAssetRef = clone(referenceDefs.analysisAssetRef);
  generated.$defs.c1OpaqueAuthorizationId = clone(referenceDefs.c1OpaqueAuthorizationId);
  const contractStringBase = {
    type: "string",
    minLength: 1,
    maxLength: 512,
    pattern: "^[^\\u0000-\\u001F\\u007F]+$"
  };
  generated.$defs.c2ContractString = contractStringBase;
  generated.$defs.c2SecretCheckedContractString = generated.$defs.formalFactString
    ? { allOf: [{ $ref: "#/$defs/c2ContractString" }, { $ref: "#/$defs/formalFactString" }] }
    : { $ref: "#/$defs/c2ContractString" };
  generated.$defs.opaqueEvidenceRef = { $ref: "#/$defs/canonicalFrozenRef" };
  if (generated.$defs.stableOpaqueEvidenceRef) {
    generated.$defs.stableOpaqueEvidenceRef = { $ref: "#/$defs/canonicalFrozenRef" };
  }
  if (generated.$defs.safeSourceRef) {
    generated.$defs.safeSourceRef = {
      oneOf: [
        { $ref: "#/$defs/canonicalFrozenRef" },
        { $ref: "#/$defs/canonicalStableHttpsAssetRef" }
      ]
    };
  }
  delete generated.$defs.safeFrozenRef;
  delete generated.$defs.httpsAssetRef;
  delete generated.$defs.safeReferenceValue;
  delete generated.$defs.safeFactReferenceValue;
  if (generated.$defs.referenceValue?.oneOf) {
    generated.$defs.referenceValue.oneOf[0] = { $ref: "#/$defs/c2SecretCheckedContractString" };
  }
  applyExplicitSemanticContracts(generated, semanticKey);
  return generated;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes("--check");
  const write = process.argv.includes("--write");
  if (checkOnly === write) {
    throw new Error("C2_REFERENCE_SCHEMA_MODE_REQUIRED: use exactly one of --check or --write");
  }

  let drift = false;
  for (const file of schemaFiles) {
    const currentText = fs.readFileSync(file, "utf8");
    const currentSchema = JSON.parse(currentText);
    const generatedSchema = ["production-authorization-v1.1", "production-authorization-v1.2"].includes(currentSchema.$id)
      ? generateProductionAuthorizationReferenceSchema(currentSchema) : generateC2ReferenceSchema(currentSchema);
    const generatedText = `${JSON.stringify(generatedSchema, null, 2)}\n`;
    if (checkOnly ? schemaObjectsEqual(currentSchema, generatedSchema) : currentText === generatedText) continue;
    if (checkOnly) {
      drift = true;
      process.stderr.write(`C2_REFERENCE_SCHEMA_DRIFT:${path.basename(file)}\n`);
    } else {
      fs.writeFileSync(file, generatedText);
    }
  }
  if (drift) process.exitCode = 1;
}
