/** Synthetic review text for pipeline tests, never a business translation. */
export function addSyntheticC1Review(request, output) {
  if (request.outputContractVersion !== "c1-ai-draft-output-v3") return output;
  for (const item of [output.title, output.description, ...output.bulletPoints, ...output.searchKeywords]) item.reviewZh = "合成测试中文审核释义";
  for (const item of output.searchKeywords) item.keywordRole = "core_product";
  output.russianAttributes = request.verifiedFacts.filter(fact => /^productAttributes\.ozonAttributes\.\d+\.fact$/.test(fact.factPath))
    .flatMap(fact => {
      const valueRu = typeof fact.value === "string" ? fact.value : fact.value.value;
      return typeof valueRu === "string" && /\p{Script=Cyrillic}/u.test(valueRu) && !/\p{Script=Han}/u.test(valueRu)
        ? [{ factPath: fact.factPath, valueRu, reviewZh: "合成测试属性释义" }] : [];
    });
  if (["c1-seo-reference-context-v2", "c1-seo-reference-context-v3"].includes(request.referenceContext.schemaVersion)) output.categoryPathReview = request.referenceContext.categoryPathBindings
    .map(({ factPath, valueRu }) => ({ factPath, valueRu, reviewZh: "合成测试类目释义" }));
  return output;
}
