import { assertC1ImageTextEvidence, assertC1ImageTextEvidenceMatches, readC1ImageTextManifest } from "./c1-image-text-evidence.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
const closed = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = () => { throw new Error("C1_SEO_REFERENCE_CONTEXT_INVALID"); };
export const C1_SEO_REFERENCE_CONTEXT_VERSION = "c1-seo-reference-context-v2";
export const C1_SUPPLIER_REFERENCE_CONTEXT_VERSION = "c1-seo-reference-context-v3";

/** Reuse an actual persisted OCR receipt only for the exact current/archived confirmed manifest. */
export function resolveC1ImageTextEvidenceForRequest(candidate, observedAt) {
  const record = candidate.lifecycleV11.c1ImageTextEvidenceV1;
  if (record === undefined) return null;
  assertC1ImageTextEvidence(record);
  if (record.status !== "completed" || !Number.isFinite(Date.parse(observedAt)) || Date.parse(record.observedAt) > Date.parse(observedAt)) fail();
  const manifest = readC1ImageTextManifest(candidate);
  assertC1ImageTextEvidenceMatches(record, manifest);
  return structuredClone(record);
}

/** Read only explicit saved description fields, never manufacture text from image URLs. */
export function savedC1CompetitorDescriptions(candidate, plan, material) {
  const frozen = plan.inputSnapshots.salesSnapshot;
  const allowedIds = new Set([frozen.snapshotId, ...material.competitorTextSnapshots.map(item => item.snapshotId)]);
  const snapshots = [frozen, ...(candidate.salesSnapshotsV11 || []), ...(candidate.lifecycleV11.opportunityPackage?.salesSnapshots || [])];
  const result = [], seen = new Map();
  for (const snapshot of snapshots) {
    if (!allowedIds.has(snapshot.snapshotId) || !text(snapshot.evidenceRef)) continue;
    const fields = [[snapshot.description, "/description"], [snapshot.attributes?.description, "/attributes/description"],
      [snapshot.attributes?.["Описание"], "/attributes/Описание"]];
    for (const [value, path] of fields) {
      if (value === undefined || value === null || value === "") continue;
      if (!text(value)) fail();
      const sourceRef = `${snapshot.evidenceRef}#${path}`;
      if (seen.has(sourceRef) && seen.get(sourceRef) !== value) fail();
      if (!seen.has(sourceRef)) { result.push({ text: value, sourceRef }); seen.set(sourceRef, value); }
    }
  }
  return result;
}

function categoryBindings(fact) {
  if (fact === null || fact === undefined || fact.verificationStatus === "unknown") return [];
  if (fact.verificationStatus !== "confirmed" || !Array.isArray(fact.sourceRefs) || !fact.sourceRefs.length || !fact.sourceRefs.every(text)) fail();
  const values = Array.isArray(fact.value) ? fact.value : [fact.value];
  if (values.some(value => !text(value))) fail();
  return values.flatMap((valueRu, index) => /\p{Script=Cyrillic}/u.test(valueRu) && !/\p{Script=Han}/u.test(valueRu)
    ? [{ factPath: `platformCategory.categoryPath${Array.isArray(fact.value) ? `.${index}` : ""}`, valueRu, evidenceRefs: [...fact.sourceRefs] }] : []);
}

export function createC1SeoReferenceContext({ competitorTextSnapshot, additionalTitles = [], additionalDescriptions = [],
  supplierTexts = [], categoryPathFact = null, imageTextEvidence = null, contextVersion = C1_SEO_REFERENCE_CONTEXT_VERSION }) {
  const supplierVersion = contextVersion === C1_SUPPLIER_REFERENCE_CONTEXT_VERSION;
  const current = supplierVersion || contextVersion === C1_SEO_REFERENCE_CONTEXT_VERSION;
  if (!current && contextVersion !== "c1-seo-reference-context-v1") fail();
  if (!supplierVersion && supplierTexts.length) fail();
  if (!current && (additionalDescriptions.length || imageTextEvidence !== null)) fail();
  const referenceTexts = competitorTextSnapshot.texts.map(item => ({ text: item.text, sourceRef: item.sourceRef, kind: "competitor_text" }));
  for (const item of additionalTitles) {
    if (item.role !== "buyer_language_reference_only" || item.adoptedAsProductFact !== false || !text(item.title) || !text(item.sourceRef)) fail();
    if (!referenceTexts.some(record => record.text === item.title && record.sourceRef === item.sourceRef)) {
      referenceTexts.push({ text: item.title, sourceRef: item.sourceRef, kind: "competitor_title" });
    }
  }
  for (const item of additionalDescriptions) {
    if (!closed(item, ["text", "sourceRef"]) || !text(item.text) || !text(item.sourceRef)) fail();
    referenceTexts.push({ ...item, kind: "competitor_description" });
  }
  for (const item of supplierTexts) {
    if (!closed(item, ["text", "sourceRef", "kind"]) || !text(item.text) || !text(item.sourceRef) ||
        !["supplier_title", "supplier_description", "supplier_attribute", "supplier_variant_attribute"].includes(item.kind)) fail();
    referenceTexts.push(structuredClone(item));
  }
  if (imageTextEvidence !== null) {
    assertC1ImageTextEvidence(imageTextEvidence);
    if (imageTextEvidence.status !== "completed") fail();
  }
  const context = { schemaVersion: contextVersion, role: "language_reference_not_product_facts", referenceTexts,
    availability: { competitorDescriptions: additionalDescriptions.length ? "provided" : "not_provided",
      imageTexts: imageTextEvidence === null ? "not_provided" : imageTextEvidence.assets.some(asset => asset.status === "extracted") ? "provided" : "no_text",
      ...(supplierVersion ? { supplierTitle: supplierTexts.some(item => item.kind === "supplier_title") ? "provided" : "not_provided",
        supplierDescriptions: supplierTexts.some(item => item.kind === "supplier_description") ? "provided" : "not_provided",
        supplierAttributes: supplierTexts.some(item => ["supplier_attribute", "supplier_variant_attribute"].includes(item.kind)) ? "provided" : "not_provided",
        imageVisualAnalysis: "not_provided" } : {}) },
    ...(current ? { categoryPathBindings: categoryBindings(categoryPathFact), imageTextEvidence: structuredClone(imageTextEvidence) } : {}) };
  assertC1SeoReferenceContext(context);
  return context;
}

export function assertC1SeoReferenceContext(context) {
  const supplierVersion = context?.schemaVersion === C1_SUPPLIER_REFERENCE_CONTEXT_VERSION;
  const current = supplierVersion || context?.schemaVersion === C1_SEO_REFERENCE_CONTEXT_VERSION;
  if (!closed(context, ["schemaVersion", "role", "referenceTexts", "availability", ...(current ? ["categoryPathBindings", "imageTextEvidence"] : [])]) ||
      (!current && context.schemaVersion !== "c1-seo-reference-context-v1") || context.role !== "language_reference_not_product_facts" ||
      !Array.isArray(context.referenceTexts) || context.referenceTexts.length < 1 || context.referenceTexts.length > 100 ||
      context.referenceTexts.some(item => !closed(item, ["text", "sourceRef", "kind"]) || !text(item.text) || item.text.length > 6000 || !text(item.sourceRef) ||
        !["competitor_text", "competitor_title", ...(current ? ["competitor_description"] : []),
          ...(supplierVersion ? ["supplier_title", "supplier_description", "supplier_attribute", "supplier_variant_attribute"] : [])].includes(item.kind)) ||
      !closed(context.availability, ["competitorDescriptions", "imageTexts", ...(supplierVersion ?
        ["supplierTitle", "supplierDescriptions", "supplierAttributes", "imageVisualAnalysis"] : [])])) fail();
  if (!current) {
    if (context.availability.competitorDescriptions !== "not_provided" || context.availability.imageTexts !== "not_provided") fail();
    return;
  }
  if (!Array.isArray(context.categoryPathBindings) || context.categoryPathBindings.length > 30 ||
      context.categoryPathBindings.some(item => !closed(item, ["factPath", "valueRu", "evidenceRefs"]) ||
        !/^platformCategory\.categoryPath(?:\.\d+)?$/.test(item.factPath) || !text(item.valueRu) || /\p{Script=Han}/u.test(item.valueRu) ||
        !/\p{Script=Cyrillic}/u.test(item.valueRu) || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length || !item.evidenceRefs.every(text)) ||
      new Set(context.categoryPathBindings.map(item => item.factPath)).size !== context.categoryPathBindings.length) fail();
  const imageRecord = context.imageTextEvidence;
  if (imageRecord !== null) {
    assertC1ImageTextEvidence(imageRecord);
    if (imageRecord.status !== "completed") fail();
  }
  const expectedImageStatus = imageRecord === null ? "not_provided" : imageRecord.assets.some(asset => asset.status === "extracted") ? "provided" : "no_text";
  if (context.availability.imageTexts !== expectedImageStatus || context.availability.competitorDescriptions !==
      (context.referenceTexts.some(item => item.kind === "competitor_description") ? "provided" : "not_provided")) fail();
  if (supplierVersion) {
    for (const [field, kinds] of [["supplierTitle", ["supplier_title"]], ["supplierDescriptions", ["supplier_description"]],
      ["supplierAttributes", ["supplier_attribute", "supplier_variant_attribute"]]]) {
      if (context.availability[field] !== (context.referenceTexts.some(item => kinds.includes(item.kind)) ? "provided" : "not_provided")) fail();
    }
    if (context.availability.imageVisualAnalysis !== "not_provided") fail();
  }
}
