import { createHash } from "node:crypto";
import { normalizeServiceOrigin } from "./runtime-configuration.mjs";

export const OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE = "russian_translation";
export const OZON_ATTRIBUTE_PROPOSAL_MODEL = "gpt-5.6-terra";
export const OZON_ATTRIBUTE_PROPOSAL_MAX_ATTRIBUTES = 25;

export class C1OzonAttributeProposalError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "C1OzonAttributeProposalError";
    this.code = code;
    this.detail = detail;
  }
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function fail(code, detail) { throw new C1OzonAttributeProposalError(code, detail); }

/**
 * 网关把 outputSchema 当结构化输出约束发给模型，并且有两条硬要求（2026-09-18 实测）：
 * **根必须是对象**（数组根会被模型原样回填成 schema），**每一层对象都要写 additionalProperties:false**。
 */
const OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["mappings"],
  properties: {
    mappings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attributeId", "russianValue", "sourceFactPath"],
        properties: {
          attributeId: { type: "string", minLength: 1, maxLength: 32 },
          russianValue: { type: "string", minLength: 1, maxLength: 120 },
          sourceFactPath: { type: "string", minLength: 1, maxLength: 200 }
        }
      }
    }
  }
});

const CHOICE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["choices"],
  properties: {
    choices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attributeId", "chosenValue"],
        properties: {
          attributeId: { type: "string", minLength: 1, maxLength: 32 },
          chosenValue: { type: "string", maxLength: 120 }
        }
      }
    }
  }
});

function sha256(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/**
 * 网关要求每次调用都交代**送出去的是哪些证据**，并逐条声明它获准发给第三方 AI。
 *
 * 这里送四样：Ozon 公开类目属性表、本品**已经核实过的中文事实**（来自货源公开商品页）、
 * 对标竞品页面上公开展示的俄语属性，以及货源公开商品页的标题。
 * 四样都是公开商品资料，不含凭证、价格策略或店铺身份，所以 authorizedForAi 为真是说得出口的。
 * 将来要送别的，这里必须重新想一遍再加。
 */
function evidenceRefsFor(attributes, facts, comparableListings = [], supplierReference = null) {
  return [
    { id: `ozon-category-attributes:${sha256(attributes).slice(0, 16)}`, kind: "ozon_category_attributes",
      contentSha256: sha256(attributes), authorizedForAi: true },
    { id: `c1-verified-facts:${sha256(facts).slice(0, 16)}`, kind: "c1_verified_product_facts",
      contentSha256: sha256(facts), authorizedForAi: true },
    // 对标页面上公开展示的俄语属性，和 C1 文案请求送的竞品文字是同一类公开材料。
    ...(comparableListings.length > 0 ? [{ id: `ozon-comparable-attributes:${sha256(comparableListings).slice(0, 16)}`,
      kind: "public_competitor_text", contentSha256: sha256(comparableListings), authorizedForAi: true }] : []),
    // 货源（1688/拼多多）公开商品页的标题，只作中文对照。
    ...(supplierReference ? [{ id: `supplier-listing-text:${sha256(supplierReference).slice(0, 16)}`,
      kind: "public_supplier_listing_text", contentSha256: sha256(supplierReference), authorizedForAi: true }] : [])
  ];
}

export const OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_LISTINGS = 5;
export const OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_TERMS = 80;
const COMPARABLE_VALUE_MAX_LENGTH = 300;

/**
 * 对标页面上**全部**俄语属性词，按页面分组送给模型——不只是和本类目属性同名的那几条。
 * 2026-10-09 主人定的做法：属性词以竞品的俄语属性词为主要素材，货源的中文资料只用来对照，
 * 一起洗出符合本商品事实、符合 Ozon 填写要求的属性值。
 */
export function normalizeComparableListings(listings) {
  if (!Array.isArray(listings)) return [];
  const result = [];
  for (const listing of listings) {
    if (result.length >= OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_LISTINGS) break;
    if (!isObject(listing) || !isObject(listing.attributes)) continue;
    const terms = [];
    for (const [name, value] of Object.entries(listing.attributes)) {
      if (terms.length >= OZON_ATTRIBUTE_PROPOSAL_MAX_COMPARABLE_TERMS) break;
      if (!nonEmpty(name) || !nonEmpty(value)) continue;
      terms.push({ name: name.trim().slice(0, 120), value: value.trim().slice(0, COMPARABLE_VALUE_MAX_LENGTH) });
    }
    if (terms.length === 0) continue;
    result.push({ from: nonEmpty(listing.from) ? String(listing.from).trim().slice(0, 120) : null, attributes: terms });
  }
  return result;
}

function normalizeSupplierReference(reference) {
  if (!isObject(reference) || !nonEmpty(reference.title)) return null;
  return { platform: nonEmpty(reference.platform) ? String(reference.platform).trim().slice(0, 40) : null,
    title: reference.title.trim().slice(0, 800) };
}

/**
 * 第二轮：**选择题**。第一轮模型凭空写俄文，2026-09-18 实测 7 条只对 1 条
 * （把「季节」填到了「动物性别」上、面料写成字典里没有的 Оксфордская ткань、
 * 颜色给了一串逗号列表）。所以这一轮只给它**字典里真实存在的候选**，让它挑一个或都不挑。
 * 它挑什么都是合法字典值——编不出来。
 */
export function buildOzonAttributeChoiceRequest({ rows, categoryLabel, candidateId, skuPackageId, dataRevision }) {
  const text = [
    "下面每一行是一个 Ozon 属性、它依据的那条中文商品事实、对标竞品在这个属性上写的俄语值，以及该属性字典里**真实存在**的候选值。",
    "请为每一行从候选里挑出一个：竞品写的值是首选参考，和中文事实相符时，优先挑与竞品值相同或最接近的候选。",
    "规则：",
    "1. chosenValue 必须**逐字**来自该行的 candidates，一个字都不能改（候选是中文的，就回中文）。",
    "2. 拿不准、或候选里没有一个真的贴合那条中文事实，就把 chosenValue 留成空字符串——**宁可不挑，不要猜**。",
    "2b. 但 required 为 true 的属性不填就发不出商品：尽最大努力挑一个确实说得通的，实在没有才留空。",
    "3. 竞品的值和这件商品的中文事实不符时（例如材质、款式不同），按中文事实挑，不要照抄竞品。",
    `类目：${categoryLabel}`,
    JSON.stringify(rows.map((item) => ({
      attributeId: item.attributeId,
      label: item.labelZh || item.label,
      required: item.required === true,
      chineseFact: item.sourceFactValue,
      comparableValues: Array.isArray(item.comparableValues) ? item.comparableValues : [],
      // 候选一律用**中文**给模型：中文事实配中文候选，比让它跨语言猜可靠得多。
      // 中文取不到的候选退回俄文原值，并如实标出来，不拿俄文冒充中文。
      candidates: item.candidates.map((x) => x.valueZh || x.value)
    }))),
    "输出一个 JSON 对象 {\"choices\":[...]}，每项只有 attributeId 和 chosenValue 两个键。",
    "不要输出解释、注释、代码块标记或对象以外的任何文字。"
  ].join("\n");
  return {
    projectId: "three-store-selection",
    candidateId, skuPackageId, dataRevision: String(dataRevision),
    businessPhase: "C1",
    taskType: OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE,
    model: OZON_ATTRIBUTE_PROPOSAL_MODEL,
    input: { text, images: [] },
    evidenceRefs: [
      { id: `ozon-dictionary-candidates:${sha256(rows).slice(0, 16)}`, kind: "ozon_dictionary_candidates",
        contentSha256: sha256(rows), authorizedForAi: true }
    ],
    outputSchema: structuredClone(CHOICE_SCHEMA)
  };
}

export function buildOzonAttributeProposalRequest({ attributes, facts, categoryLabel, candidateId, skuPackageId, dataRevision,
  comparableListings = [], supplierReference = null }) {
  const listings = normalizeComparableListings(comparableListings);
  const supplier = normalizeSupplierReference(supplierReference);
  const text = [
    "下面是一个 Ozon 俄罗斯电商类目的属性清单、对标竞品页面上的俄语属性词、货源商品页的中文资料，以及本商品**已经核实过的中文事实**。",
    "做法：以竞品的俄语属性词为主要素材，对照货源中文资料和已核实事实，为本商品洗出每个属性的**俄文属性值**。",
    "规则：",
    "1. 竞品的俄语属性词是首选措辞：竞品写的值和本商品事实相符时，直接用竞品的俄语原词。",
    "2. 竞品的值和本商品事实不符时（例如材质、款式、尺寸不同），不要照抄，改写成符合本商品事实的俄文值。",
    "3. 货源中文资料和已核实事实用来对照核实，**不得创造任何商品事实**；两者都没有的信息一律不要补。",
    "4. 找不到依据的属性，**直接不要出现在结果里**——宁可少给，不要猜。",
    "4b. 但 required 为 true 的属性**不填就发不出商品**：请尽最大努力从事实里找依据，",
    "    实在没有直接对应的，也可以用类目路径这类间接但真实的依据，只要它确实支持这个值。",
    "5. 俄文值必须写成 **Ozon 属性字典里的那个词本身**——尽量短、不要加任何修饰词。",
    "   例：面料写 Оксфорд（不是 Оксфордская ткань）；类型写 Одежда（软件会自动补全成字典里的完整值）。",
    "6. 一个属性只给**一个**值，不要给逗号分隔的列表；多个颜色/季节就挑最有代表性的那一个。",
    "7. 属性号必须逐字抄自属性清单里的 attributeId，**不要挑错属性**（季节和动物性别是两个不同的属性）。",
    "8. sourceFactPath 填支持这个值的那条已核实事实，必须逐字抄自下面事实清单里的 factPath，不得改写。",
    `类目：${categoryLabel}`,
    `属性清单（共 ${attributes.length} 个）：`,
    JSON.stringify(attributes.map((item) => ({
      attributeId: item.fieldKey, label: item.labelZh || item.label, required: item.required === true
    }))),
    `对标竞品页面上的俄语属性词（共 ${listings.length} 个页面）：`,
    JSON.stringify(listings),
    `货源商品页中文资料：`,
    JSON.stringify(supplier ?? {}),
    `已核实的中文事实（共 ${facts.length} 条）：`,
    JSON.stringify(facts.map((item) => ({ factPath: item.factPath, value: item.value }))),
    "输出一个 JSON 对象 {\"mappings\":[...]}，每项只有 attributeId、russianValue、sourceFactPath 三个键。",
    "不要输出解释、注释、代码块标记或数组以外的任何文字。"
  ].join("\n");
  if (!nonEmpty(candidateId) || !nonEmpty(skuPackageId) || !nonEmpty(String(dataRevision ?? ""))) {
    fail("INPUT_INVALID", "网关要求请求绑定到具体候选：candidateId、skuPackageId、dataRevision 缺一不可");
  }
  return {
    projectId: "three-store-selection",
    // 回执要追得回是给哪件商品、哪一版做的——网关把这三样列为必填，理由成立。
    candidateId, skuPackageId, dataRevision: String(dataRevision),
    businessPhase: "C1",
    taskType: OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE,
    model: OZON_ATTRIBUTE_PROPOSAL_MODEL,
    input: { text, images: [] },
    evidenceRefs: evidenceRefsFor(attributes, facts, listings, supplier),
    outputSchema: structuredClone(OUTPUT_SCHEMA)
  };
}

function parseProposals(output, jobId) {
  let parsed = output;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { fail("GATEWAY_FAILED", `模型输出不是合法JSON（作业 ${jobId}）`); }
  }
  const list = isObject(parsed) ? parsed.mappings : parsed;
  if (!Array.isArray(list)) fail("GATEWAY_FAILED", `模型输出缺少 mappings 数组（作业 ${jobId}）`);
  return list.filter(isObject)
    .map((item) => ({
      attributeId: nonEmpty(item.attributeId) ? String(item.attributeId).trim() : null,
      russianValue: nonEmpty(item.russianValue) ? String(item.russianValue).trim() : null,
      sourceFactPath: nonEmpty(item.sourceFactPath) ? String(item.sourceFactPath).trim() : null
    }))
    .filter((item) => item.attributeId && item.russianValue && item.sourceFactPath);
}

/**
 * 给主人一张**已经填好的** Ozon 属性表，他只需逐行判断「是不是」，而不是自己打俄文。
 *
 * 为什么必须这样：2026-09-18 主人原话——「你这个让我填？那我干嘛不自己去上架呢？」。
 * 他说得对。软件已经握着两端的全部材料（已核实的中文事实、Ozon 自己的属性字典），
 * 让他手打六个俄文词，等于把软件该干的活推回给他。
 *
 * 三层分工，每层只做自己能负责的事：
 *  - **模型**（4318 网关 `russian_translation`）只做**配对与翻译**：哪条中文事实对应哪个属性、
 *    那个属性值的俄文怎么写。它**不决定任何事**。
 *  - **Ozon 字典**做裁决：模型给的俄文值拿去**逐字查平台字典**，查不到就**不提这一条**。
 *    这样模型再怎么胡说也编不出一个平台上不存在的属性值——
 *    这正是 [[search-keyword-text-is-not-gated]] 那个坑的解法：不给模型直接写业务字段的机会。
 *  - **主人**做判断：他看到的是「俄文值 + 真实字典号 + 它依据的那条中文事实」，点头或换一个。
 *
 * 另外把**已采到的对标页面上出现过、且确实在字典里**的值也一并列为备选——
 * 那些不花钱、证据更硬（页面实拍 + 平台字典两端都有）。
 */
export const OZON_ATTRIBUTE_FULL_CHOICE_MAX_CANDIDATES = 60;

export function createC1OzonAttributeProposer({
  gatewayUrl,
  readDictionaryValue,
  readDictionaryValues = null,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timeoutMs = 180_000,
  gatewayDeploymentMode = "local_development",
  wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  statusIntervalMs = 500,
  maxStatusReads = 600
} = {}) {
  if (typeof readDictionaryValue !== "function" || typeof fetchImpl !== "function" || typeof wait !== "function" ||
      (readDictionaryValues !== null && typeof readDictionaryValues !== "function")) {
    fail("INPUT_INVALID", "属性建议依赖配置无效");
  }
  let baseUrl;
  try { baseUrl = normalizeServiceOrigin(gatewayUrl, { deploymentMode: gatewayDeploymentMode, label: "aiGatewayUrl" }); }
  catch (error) { fail("INPUT_INVALID", `AI网关地址无效：${String(error?.message || error)}`); }

  const clockMs = () => {
    const at = now();
    const value = typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(value)) fail("INPUT_INVALID", "服务时钟无效");
    return value;
  };
  async function gatewayJson(response, jobId = null) {
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      // 网关会说清楚它嫌什么（哪条证据、哪个字段）。丢掉这句话，排查就只能靠裸调猜。
      const reason = isObject(body?.error) ? `${body.error.code}: ${body.error.message}` : JSON.stringify(body)?.slice(0, 200);
      fail("GATEWAY_FAILED", `AI网关返回 HTTP ${response.status}${jobId ? `（作业 ${jobId}）` : ""} —— ${reason}`);
    }
    if (!isObject(body)) fail("GATEWAY_FAILED", "AI网关返回结构无效");
    return body;
  }

  async function runJob(request) {
    const deadline = clockMs() + timeoutMs;
    let job = await gatewayJson(await fetchImpl(`${baseUrl}/v1/inference-jobs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request)
    }));
    const jobId = job.jobId;
    if (!nonEmpty(jobId) || jobId.length > 200) fail("GATEWAY_FAILED", "AI网关未返回任务编号");
    for (let read = 0; ["queued", "running"].includes(job.status); read += 1) {
      if (read >= maxStatusReads || clockMs() >= deadline) fail("TIMEOUT", `属性建议读取超时；未重发请求（作业 ${jobId}）`);
      await wait(statusIntervalMs);
      job = await gatewayJson(await fetchImpl(`${baseUrl}/v1/inference-jobs/${encodeURIComponent(jobId)}`), jobId);
    }
    if (job.status !== "completed" || !isObject(job.receipt)) fail("GATEWAY_FAILED", `属性建议任务未完成并已停止（作业 ${jobId}）`);
    if (job.model !== OZON_ATTRIBUTE_PROPOSAL_MODEL || job.taskType !== OZON_ATTRIBUTE_PROPOSAL_TASK_TYPE) {
      fail("GATEWAY_FAILED", `网关回执与已锁定的任务不一致（作业 ${jobId}）`);
    }
    return { output: job.receipt.output, jobId, usage: job.receipt.usage ?? null };
  }

  async function translate(args) {
    const { output, jobId, usage } = await runJob(buildOzonAttributeProposalRequest(args));
    return { proposals: parseProposals(output, jobId), jobId, usage };
  }

  /** 让模型在**字典真实候选**里挑。挑出来的东西一定是合法字典值，它编不出来。 */
  async function chooseFromCandidates(args) {
    const { output, jobId, usage } = await runJob(buildOzonAttributeChoiceRequest(args));
    let parsed = output;
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { parsed = null; } }
    const list = isObject(parsed) ? parsed.choices : null;
    if (!Array.isArray(list)) fail("GATEWAY_FAILED", `选择结果缺少 choices 数组（作业 ${jobId}）`);
    const byId = new Map();
    for (const item of list) {
      if (!isObject(item) || !nonEmpty(item.attributeId)) continue;
      byId.set(String(item.attributeId).trim(), nonEmpty(item.chosenValue) ? String(item.chosenValue).trim() : null);
    }
    return { byId, jobId, usage };
  }

  return Object.freeze({
    /**
     * @param attributes  冻结 schema 的属性（fieldKey/label/dictionaryId/required）
     * @param facts       计划里已确认且非 unknown 的字符串事实（factPath/value）
     * @param comparableAttributes  已采到的对标页面上「属性名 → [{value, from}]」，按属性名对齐
     * @param comparableListings    对标页面的**全部**俄语属性 [{from, attributes:{名:值}}]，作为模型的主要素材
     * @param supplierReference     货源商品页中文资料 {platform, title}，只作对照
     *
     * 两轮：第一轮模型给短词，第二轮它在**字典真实候选**里挑。中间夹一层确定性捞回。
     *
     * 两类结果分得很清楚：
     *  - **suggestion**：由我们**自己的已确认事实**得来、并且值一定是字典里真实存在的。默认勾选。
     *  - **alternatives**：抄自对标页面的值，同样过字典，但**默认不勾选**。
     *    那是**别人家商品**的属性：对标写「真皮 + ABS 塑料」，我们是牛津布；
     *    对标写 Жакет（夹克），我们是 Жилет（背心）。抄错材质是买家收货要退、平台按属性不符处罚的事。
     */
    async propose({ attributes, facts, categoryLabel, store, category, candidateId, skuPackageId, dataRevision, comparableAttributes = new Map(),
      comparableListings = [], supplierReference = null }) {
      if (!Array.isArray(attributes) || attributes.length === 0) fail("INPUT_INVALID", "没有可映射的类目属性");
      if (!Array.isArray(facts) || facts.length === 0) fail("INPUT_INVALID", "没有可当依据的已确认事实");
      if (attributes.length > OZON_ATTRIBUTE_PROPOSAL_MAX_ATTRIBUTES) {
        fail("INPUT_INVALID", `一次最多处理 ${OZON_ATTRIBUTE_PROPOSAL_MAX_ATTRIBUTES} 个属性`);
      }
      const factByPath = new Map(facts.map((item) => [item.factPath, item.value]));

      /**
       * 字典小到能整份发过去的属性，直接让模型做**选择题**。
       * 2026-09-18 实测：同一批属性，让模型凭空写俄文是 7 条对 1 条
       * （季节填到动物性别上、Вид одежды 选了 Костюм 套装）；
       * 换成给它真实候选去挑，是 **5 对 1 弃权 0 错**——季节选对了 На любой сезон，
       * 衣型选对了 Жилет，颜色因为原料是五个颜色它诚实地没挑。差别就在它看不看得见候选。
       */
      const fullChoice = [];
      if (typeof readDictionaryValues === "function") {
        for (const attribute of attributes) {
          const id = String(attribute.fieldKey);
          if (!(Number(attribute.dictionaryId) > 0)) continue;
          let listed = null;
          try { listed = await readDictionaryValues({ store, category, attributeId: id }); } catch { listed = null; }
          const data = listed?.evidenceData ?? {};
          // 平台说还有下一页就不能当完整候选用——截断的一段会让模型在残缺集合里挑。
          if (data.complete !== true || !Array.isArray(data.values)) continue;
          if (data.values.length === 0 || data.values.length > OZON_ATTRIBUTE_FULL_CHOICE_MAX_CANDIDATES) continue;
          fullChoice.push({ attributeId: id, label: attribute.label ?? null,
            candidates: data.values.map((item) => ({ ...item, dictionaryEvidenceRef: listed.sourceRef ?? null })) });
        }
      }

      const first = await translate({ attributes, facts, categoryLabel, candidateId, skuPackageId, dataRevision,
        comparableListings, supplierReference });
      const comparableValuesFor = (attribute) => (comparableAttributes.get(attribute?.label) ?? [])
        .map((item) => item?.value).filter(nonEmpty).slice(0, 10);

      const searched = new Map();
      async function search(attributeId, value) {
        const key = `${attributeId}\u0000${value}`;
        if (searched.has(key)) return searched.get(key);
        let result = { exact: null, matches: [] };
        try {
          const read = await readDictionaryValue({ store, category, attributeId, value });
          const data = read?.evidenceData ?? {};
          result = {
            exact: isObject(data.exactMatch) ? { ...data.exactMatch, dictionaryEvidenceRef: read.sourceRef ?? null } : null,
            matches: (Array.isArray(data.matches) ? data.matches : []).map((item) => ({ ...item, dictionaryEvidenceRef: read.sourceRef ?? null }))
          };
        } catch { result = { exact: null, matches: [] }; }
        searched.set(key, result);
        return result;
      }

      /**
       * 确定性捞回：模型给的词查不到时，逐步缩短它去搜。
       * 字典搜索是**包含式**的（搜 Одежда 能捞回 Одежда для животных），
       * 但模型多加了词就捞不回（Оксфордская ткань 搜不到 Оксфорд），所以从右边一个字一个字截短。
       * 截到 4 个字符为止——再短就会捞回一堆不相干的值。
       */
      async function recover(attributeId, term) {
        const direct = await search(attributeId, term);
        if (direct.exact) return [{ ...direct.exact }];
        if (direct.matches.length) return direct.matches;
        const head = term.split(/[\s,，]/)[0] ?? term;
        for (let length = head.length - 1; length >= 4; length -= 1) {
          const shorter = head.slice(0, length);
          const attempt = await search(attributeId, shorter);
          if (attempt.exact) return [{ ...attempt.exact }];
          if (attempt.matches.length) return attempt.matches;
        }
        return [];
      }

      const rows = [];
      const needChoice = [];
      for (const attribute of attributes) {
        const id = String(attribute.fieldKey);
        const row = {
          attributeId: id, label: attribute.label ?? null, labelZh: attribute.labelZh ?? null,
          required: attribute.required === true,
          dictionaryId: Number(attribute.dictionaryId) || 0,
          suggestion: null, rejectedByDictionary: null, alternatives: []
        };
        const proposed = first.proposals.find((item) => item.attributeId === id);
        const full = fullChoice.find((item) => item.attributeId === id);
        if (proposed && factByPath.has(proposed.sourceFactPath) && full) {
          // 字典整份拿得到：直接让模型在真实候选里挑，不用它自己写的词。
          needChoice.push({ attributeId: id, label: row.label, labelZh: row.labelZh, required: row.required,
            sourceFactPath: proposed.sourceFactPath,
            sourceFactValue: factByPath.get(proposed.sourceFactPath), comparableValues: comparableValuesFor(attribute),
            candidates: full.candidates });
        } else if (proposed && factByPath.has(proposed.sourceFactPath)) {
          const sourceFactValue = factByPath.get(proposed.sourceFactPath);
          if (row.dictionaryId === 0) {
            row.suggestion = { value: proposed.russianValue, dictionaryValueId: null,
              sourceFactPath: proposed.sourceFactPath, sourceFactValue,
              origin: "own_fact_translated_free_text", dictionaryEvidenceRef: null };
          } else {
            const candidates = await recover(id, proposed.russianValue);
            if (candidates.length === 1) {
              row.suggestion = { value: candidates[0].value, valueZh: candidates[0].valueZh ?? null, dictionaryValueId: candidates[0].dictionaryValueId,
                sourceFactPath: proposed.sourceFactPath, sourceFactValue,
                origin: "own_fact_translated_verified_by_dictionary",
                dictionaryEvidenceRef: candidates[0].dictionaryEvidenceRef ?? null };
            } else if (candidates.length > 1) {
              needChoice.push({ attributeId: id, label: row.label, labelZh: row.labelZh, required: row.required,
                sourceFactPath: proposed.sourceFactPath, sourceFactValue, comparableValues: comparableValuesFor(attribute), candidates });
            } else {
              row.rejectedByDictionary = proposed.russianValue;
            }
          }
        }
        rows.push(row);
      }

      // 第二轮只在真的有多个候选时才发，没有就不花这笔钱。
      let choiceJobId = null; let choiceUsage = null;
      if (needChoice.length > 0) {
        const chosen = await chooseFromCandidates({ rows: needChoice, categoryLabel, candidateId, skuPackageId, dataRevision });
        choiceJobId = chosen.jobId; choiceUsage = chosen.usage;
        for (const item of needChoice) {
          const row = rows.find((entry) => entry.attributeId === item.attributeId);
          const picked = chosen.byId.get(item.attributeId) ?? null;
          // 模型回的是中文候选，要按中文找回那一条；找不到再按俄文兜一次。
          const match = picked === null ? null
            : item.candidates.find((entry) => (entry.valueZh || entry.value) === picked)
              ?? item.candidates.find((entry) => entry.value === picked);
          if (match) {
            row.suggestion = { value: match.value, valueZh: match.valueZh ?? null, dictionaryValueId: match.dictionaryValueId,
              sourceFactPath: item.sourceFactPath, sourceFactValue: item.sourceFactValue,
              origin: "own_fact_translated_chosen_from_dictionary",
              dictionaryEvidenceRef: match.dictionaryEvidenceRef ?? null };
          } else {
            // 模型没挑、或挑了一个不在候选里的值：把真实候选原样交给主人，不替他决定。
            row.alternatives.push(...item.candidates.map((entry) => ({
              value: entry.value, valueZh: entry.valueZh ?? null, dictionaryValueId: entry.dictionaryValueId,
              capturedFrom: null, origin: "dictionary_candidate_unresolved"
            })));
          }
        }
      }

      // 竞品词已经作为主要素材交给模型洗过，洗出来的结果就是上面默认勾选的 suggestion。
      // 这里再把对标页面上同名属性的原值列出来，供主人改选；它们没有本商品自己的事实依据，所以不默认勾选。
      for (const row of rows) {
        const attribute = attributes.find((item) => String(item.fieldKey) === row.attributeId);
        for (const captured of (comparableAttributes.get(attribute?.label) ?? [])) {
          if (!nonEmpty(captured?.value)) continue;
          if (row.suggestion && row.suggestion.value === captured.value) continue;
          if (row.alternatives.some((item) => item.value === captured.value)) continue;
          if (row.dictionaryId === 0) {
            row.alternatives.push({ value: captured.value, valueZh: null, dictionaryValueId: null,
              capturedFrom: captured.from ?? null, origin: "copied_from_comparable_listing" });
            continue;
          }
          const hit = (await search(row.attributeId, captured.value)).exact;
          if (!hit) continue;
          row.alternatives.push({ value: hit.value, valueZh: hit.valueZh ?? null, dictionaryValueId: hit.dictionaryValueId,
            capturedFrom: captured.from ?? null, origin: "copied_from_comparable_listing" });
        }
      }

      return Object.freeze({
        schemaVersion: "c1-ozon-attribute-proposal-v1",
        rows,
        jobIds: [first.jobId, choiceJobId].filter(Boolean),
        model: OZON_ATTRIBUTE_PROPOSAL_MODEL,
        usage: { translate: first.usage, choose: choiceUsage },
        suggestedCount: rows.filter((item) => item.suggestion !== null).length,
        alternativeOnlyCount: rows.filter((item) => item.suggestion === null && item.alternatives.length > 0).length,
        proposedAt: new Date(clockMs()).toISOString()
      });
    }
  });
}
