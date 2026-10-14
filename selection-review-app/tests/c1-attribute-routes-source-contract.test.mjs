import test from "node:test";
import assert from "node:assert/strict";

/*
 * HTTP 到用例之间的接线，这个仓库一贯用源码合同测试来守（见 c1-fact-keyword-server-integration）。
 * 本机身份是 local_owner_password，自动化拿不到也不该拿主人的密码，
 * 所以带身份的真实往返只能靠主人自己点一次；这里守住的是**参数确实传对了**——
 * 路由拿到的 dataRevision 必须原样当 expectedRevision 传下去，
 * skuPackageId 必须来自服务端当前快照而不是请求体（客户端不能指定改哪个SKU包）。
 */
test("路由把主人的请求原样接到用例上，SKU包身份只认服务端快照", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  for (const route of ["supply-attribute-backfill", "ozon-attributes", "ozon-attribute-mapping", "refresh-category-schema", "ozon-attribute-proposal"]) {
    assert.ok(server.includes(`\\/lifecycle\\/c1\\/${route}$`), `缺少路由 ${route}`);
  }
  // 三条路由都必须先查已认证的真人主人身份。
  assert.equal(server.split("C1_SUPPLY_ATTRIBUTE_BACKFILL_OWNER_REQUIRED").length - 1, 1);
  assert.equal(server.split("C1_OZON_ATTRIBUTE_MAPPING_OWNER_REQUIRED").length - 1, 2);

  const backfill = server.slice(server.indexOf("c1SupplyAttributeBackfillRoute = pathname.match"),
    server.indexOf("c1RefreshSchemaRoute = pathname.match"));
  assert.match(backfill, /expectedRevision: input\.dataRevision/);
  assert.match(backfill, /skuPackageId = current\.lifecycleV11\?\.skuPackage\?\.skuPackageId/);
  assert.doesNotMatch(backfill, /input\.skuPackageId/, "SKU包身份不能由客户端指定");

  const mapping = server.slice(server.indexOf("c1OzonAttributeMappingRoute = pathname.match"),
    server.indexOf("retiredFireTrainC1Route"));
  assert.match(mapping, /expectedRevision: input\.dataRevision/);
  assert.match(mapping, /mappings: input\.mappings/);
  assert.doesNotMatch(mapping, /input\.skuPackageId/, "SKU包身份不能由客户端指定");

  // 字典读取器必须延迟到调用时才构造：它对非本机地址直接抛，在模块顶层构造会让整个评审台起不来。
  assert.match(server, /readDictionaryValue: \(request\) => createOzonDictionaryValueReader\(/);
  // 错误码要翻成主人看得懂的话，而不是把内部码丢到界面上。
  assert.match(server, /function supplyBackfillMessage\(code\)/);
  assert.match(server, /function ozonMappingMessage\(code, detail = null\)/);
  assert.match(server, /function frozenSchemaRefreshMessage\(code\)/);

  // 重读类目资料：证据包和计划里那份必须**同一次落盘**，只提交其中一个就会让引用指向不存在的包。
  const refresh = server.slice(server.indexOf("c1RefreshSchemaRoute = pathname.match"),
    server.indexOf("c1OzonAttributeProposalRoute = pathname.match"));
  assert.match(refresh, /refreshC1FrozenPlatformSchema\(\{/);
  assert.match(refresh, /commitLifecycleBEvidencePacks\(data, \[pack\]/);
  assert.ok(refresh.indexOf("await mutateData(") < refresh.indexOf("commitLifecycleBEvidencePacks"),
    "提交证据包必须在同一次 mutateData 里");
  assert.ok(refresh.indexOf("providers.schema(") < refresh.indexOf("await mutateData("),
    "外部读取必须在事务之外完成");
  assert.doesNotMatch(refresh, /input\.skuPackageId/, "SKU包身份不能由客户端指定");

  // 生成属性建议：会花 AI 调用的钱，必须是主人主动点，且只在事实尚未冻结时可做。
  const proposal = server.slice(server.indexOf("c1OzonAttributeProposalRoute = pathname.match"),
    server.indexOf("c1ColorDictionaryRoute = pathname.match"));
  assert.match(proposal, /C1_OZON_ATTRIBUTE_PROPOSAL_OWNER_REQUIRED/);
  assert.match(proposal, /plan\.status !== "inputs_ready"/);
  assert.match(proposal, /readDictionaryValues: createOzonDictionaryValuesReader\(/);
  // 建议这一步**不写任何数据**：它只读、只算，写入要主人另外点「全部同意并保存」。
  assert.doesNotMatch(proposal, /mutateData|executeBusinessMutation/, "生成建议不得写入任何数据");
  // 已由主人声明确认的必填属性不得再摆进建议表——否则模型会给它硬配一条假依据。
  assert.match(proposal, /settledByDeclaration/);
  assert.match(proposal, /!settledByDeclaration\.has\(String\(item\.fieldKey\)\)/);
  assert.doesNotMatch(proposal, /input\.skuPackageId/, "SKU包身份不能由客户端指定");

  // 可选依据里必须排除映射自己的产出，否则一条映射会绑回自己，漂移守卫就此失效。
  const facts = server.slice(server.indexOf("function collectConfirmedStringFacts"),
    server.indexOf("function frozenSchemaRefreshMessage"));
  assert.match(facts, /OZON_ATTRIBUTE_SELF_PROJECTION_PREFIXES\.some/);
  // 两段派生事实都要排除：ozonAttributes 是映射的投影，requiredPlatformFields 也会被映射回填。
  assert.match(server, /"productAttributes\.ozonAttributes",\s*\n\s*"productAttributes\.requiredPlatformFields"/);
});

test("界面不得直接渲染事实值——那会整页白屏", async () => {
  // 2026-09-18 真让主人白屏了一次：品牌那行的依据是对象 {status:"unbranded", name:null}，
  // 面板直接 {row.suggestion.sourceFactValue} 渲染，React 一碰对象就抛，整页白。
  // 事实值**本来就不一定是字符串**（主人签的声明就是对象），所以这不是偶发，是必然。
  const { readFile } = await import("node:fs/promises");
  const panel = await readFile(new URL("../src/components/C1OzonAttributePanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /function readableFact\(value\)/, "必须有把任意值转成可读文字的兜底");
  // 任何出现 sourceFactValue 的渲染位置都要经过 readableFact。
  for (const line of panel.split("\n")) {
    if (!line.includes("sourceFactValue")) continue;
    if (!line.includes("{") || !line.includes("}")) continue;
    assert.ok(line.includes("readableFact(") || line.includes("sourceFactText"),
      `事实值必须先转可读文字再渲染：${line.trim()}`);
  }
  // 服务端给的显示文字是**另一个字段**：比较用的 sourceFactValue 一个字不能动，
  // 否则漂移守卫会永远判成漂移。
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(server, /sourceFactValue: structuredClone\(declaration\.value\)/);
  assert.match(server, /sourceFactText:/);
});
