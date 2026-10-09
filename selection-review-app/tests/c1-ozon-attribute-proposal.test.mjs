import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOzonAttributeChoiceRequest,
  buildOzonAttributeProposalRequest,
  createC1OzonAttributeProposer,
  normalizeComparableListings,
  OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_LISTINGS,
  OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_TERMS,
  OZON_ATTRIBUTE_PROPOSAL_MODEL,
  OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE
} from "../lib/c1-ozon-attribute-proposal.mjs";

const identity = { candidateId: "candidate:synthetic-vest", skuPackageId: "sku:synthetic-vest", dataRevision: 7 };
const attributes = [
  { fieldKey: "8229", label: "Тип", labelZh: "类型", dictionaryId: 1960, required: true },
  { fieldKey: "4495", label: "Сезон", labelZh: "季节", dictionaryId: 1961, required: false }
];
const facts = [
  { factPath: "productAttributes.supplierAttributes.0.fact", value: "背心" },
  { factPath: "productAttributes.supplierAttributes.1.fact", value: "四季通用" }
];
const comparableListings = [
  { from: "ozon:100", attributes: { "Тип": "Жилет для животных", "Сезон": "На любой сезон", "Материал": "Оксфорд" } },
  { from: "ozon:200", attributes: { "Тип": "Жакет для животных" } }
];
const supplierReference = { platform: "1688", title: "宠物猫咪背心 牛津布 四季通用" };

function gatewayJob(request, output, jobId) {
  return { jobId, status: "completed", model: request.model, taskType: request.taskType, receipt: { output, usage: null } };
}

test("proposal request sends every competitor attribute as the main material and the supplier title as reference", () => {
  const request = buildOzonAttributeProposalRequest({ attributes, facts, categoryLabel: "Одежда для животных", ...identity,
    comparableListings, supplierReference });
  assert.equal(request.model, OZON_ATTRIBUTE_PROPOSAL_MODEL);
  assert.equal(request.taskType, OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE);
  assert.match(request.input.text, /以竞品的俄语属性词为主要素材/);
  // Attributes that share no name with the category list still reach the model.
  assert.match(request.input.text, /"name":"Материал","value":"Оксфорд"/);
  assert.match(request.input.text, /"name":"Тип","value":"Жакет для животных"/);
  assert.match(request.input.text, /宠物猫咪背心 牛津布 四季通用/);
  assert.deepEqual(request.evidenceRefs.map((item) => item.kind),
    ["ozon_category_attributes", "c1_verified_product_facts", "public_competitor_text", "public_supplier_listing_text"]);
  assert.ok(request.evidenceRefs.every((item) => item.authorizedForAi === true && /^[0-9a-f]{64}$/.test(item.contentSha256)));
  assert.deepEqual(request.outputSchema.required, ["mappings"]);
});

test("proposal request without competitor pages or supplier title declares only what it sends", () => {
  const request = buildOzonAttributeProposalRequest({ attributes, facts, categoryLabel: "Одежда для животных", ...identity });
  assert.deepEqual(request.evidenceRefs.map((item) => item.kind), ["ozon_category_attributes", "c1_verified_product_facts"]);
  assert.match(request.input.text, /共 0 个页面/);
});

test("competitor listings are bounded and drop empty or non-text values", () => {
  const many = Array.from({ length: OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_LISTINGS + 3 }, (_, index) => ({
    from: `ozon:${index}`,
    attributes: Object.fromEntries(Array.from({ length: OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_TERMS + 5 },
      (_, term) => [`name-${term}`, `value-${term}`]))
  }));
  const normalized = normalizeComparableListings([{ from: "empty", attributes: { "Тип": "  ", "Вес": 3 } }, null, ...many]);
  assert.equal(normalized.length, OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_LISTINGS);
  assert.equal(normalized[0].from, "ozon:0");
  assert.ok(normalized.every((item) => item.attributes.length === OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_TERMS));
  assert.deepEqual(normalizeComparableListings("not a list"), []);
});

test("choice request shows the competitor value next to each row", () => {
  const request = buildOzonAttributeChoiceRequest({ ...identity, categoryLabel: "Одежда для животных", rows: [{
    attributeId: "8229", label: "Тип", labelZh: "类型", required: true, sourceFactValue: "背心",
    comparableValues: ["Жилет для животных"], candidates: [{ value: "Жилет для животных", valueZh: "宠物背心" }]
  }] });
  assert.match(request.input.text, /竞品写的值是首选参考/);
  assert.match(request.input.text, /"comparableValues":\["Жилет для животных"\]/);
  assert.deepEqual(request.outputSchema.required, ["choices"]);
});

test("washed competitor wording becomes the default suggestion and stays bound to our own fact", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    sent.push(request);
    const output = request.outputSchema.required[0] === "mappings"
      ? { mappings: [
          { attributeId: "8229", russianValue: "Жилет для животных", sourceFactPath: facts[0].factPath },
          { attributeId: "4495", russianValue: "На любой сезон", sourceFactPath: facts[1].factPath }
        ] }
      : { choices: [{ attributeId: "4495", chosenValue: "任何季节" }] };
    return new Response(JSON.stringify(gatewayJob(request, output, `job:${sent.length}`)), { status: 200 });
  };
  const readDictionaryValue = async ({ attributeId, value }) => ({ sourceRef: `dictionary:${attributeId}`, evidenceData:
    attributeId === "8229" && value === "Жилет для животных"
      ? { exactMatch: { value, valueZh: "宠物背心", dictionaryValueId: 970000001 }, matches: [] }
      : { exactMatch: null, matches: [] } });
  const readDictionaryValues = async ({ attributeId }) => ({ sourceRef: `dictionary-list:${attributeId}`, evidenceData:
    attributeId === "4495"
      ? { complete: true, values: [{ value: "На любой сезон", valueZh: "任何季节", dictionaryValueId: 970000010 },
        { value: "Зима", valueZh: "冬季", dictionaryValueId: 970000011 }] }
      : { complete: false, values: [] } });
  const proposer = createC1OzonAttributeProposer({ gatewayUrl: "http://127.0.0.1:4318", readDictionaryValue, readDictionaryValues,
    fetchImpl, now: () => "2026-10-09T00:00:00.000Z" });
  const comparableAttributes = new Map([
    ["Тип", [{ value: "Жилет для животных", from: "ozon:100" }, { value: "Жакет для животных", from: "ozon:200" }]],
    ["Сезон", [{ value: "На любой сезон", from: "ozon:100" }]]
  ]);
  const proposal = await proposer.propose({ attributes, facts, categoryLabel: "Одежда для животных", store: "miska",
    category: "ozon:1:2", ...identity, dataRevision: "7", comparableAttributes, comparableListings, supplierReference });

  assert.equal(sent.length, 2);
  assert.match(sent[0].input.text, /Жакет для животных/);
  assert.match(sent[1].input.text, /"comparableValues":\["На любой сезон"\]/);

  const type = proposal.rows.find((row) => row.attributeId === "8229");
  assert.equal(type.suggestion.value, "Жилет для животных");
  assert.equal(type.suggestion.dictionaryValueId, 970000001);
  assert.equal(type.suggestion.sourceFactPath, facts[0].factPath);
  // The competitor's identical value is not listed twice; a different competitor value is only offered when the dictionary has it.
  assert.deepEqual(type.alternatives, []);

  const season = proposal.rows.find((row) => row.attributeId === "4495");
  assert.equal(season.suggestion.value, "На любой сезон");
  assert.equal(season.suggestion.origin, "own_fact_translated_chosen_from_dictionary");
  assert.equal(proposal.suggestedCount, 2);
});
