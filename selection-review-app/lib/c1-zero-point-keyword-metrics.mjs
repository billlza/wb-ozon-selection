import { keywordMetricKey } from "./keyword-evidence-scoring.mjs";

export const ZERO_POINT_KEYWORD_METRICS_VERSION = "keyword-metrics-v1";

/**
 * 语义匹配不逐词打分，按**主人已经给过的可比性判定**推出来。
 *
 * `target_fact` 是本品自己已确认的事实词，`exact_match` 来自主人判定「与本品同款」的对标，
 * 两者描述的都是本品本身，记 100；`substitute` 是主人判定的「替代品」，记 85——仍在
 * scoreCandidate 的 80 分线之上，但明确低于同款。`multi_seed` 没有任何可比性背书，记 null，
 * 由评分那一步判成 semantic_match_missing 拒掉。
 *
 * 为什么不让 AI 给每个词打一个分：AI 说 87 分，没人能复算，也没人能证伪。
 * 匹配类型是主人签过、有证据引用、可以逐条查的。
 */
const SEMANTIC_BY_MATCH_TYPE = Object.freeze({ target_fact: 100, exact_match: 100, substitute: 85, multi_seed: null });
const SEMANTIC_RULE = "按主人已证的可比性判定：target_fact/exact_match=100、substitute=85、multi_seed=null（不逐词打分）";

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function contains(haystack, needle) { return String(haystack).toLocaleLowerCase().includes(String(needle).toLocaleLowerCase()); }
function round4(value) { return Number(value.toFixed(4)); }

function component({ value, raw, rule, evidenceRef, observedAt, period = null }) {
  if (value === null) return null;
  return { value: round4(value), rawValue: null, raw, normalizationRule: rule, evidenceRef, observedAt, ...(period === null ? {} : { period }) };
}

/**
 * 零点数关键词指标：只给**本地能算出来**的那五项，要付费数据的四项如实留空。
 *
 * 九项里 `searchDemand`、`addToCartConversion`、`searchGrowth`、`returnCancelHealth`
 * （合计权重 34）必须有平台或第三方的真实读数，这条路一次外部调用都不打，所以**留 null**。
 * `lib/keyword-evidence-scoring.mjs` 的 compositeScore 是 `weighted / availableWeight`——
 * 只按真有值的指标算分，缺的那几项不扣分，只把 evidenceCoverage / confidence 降到 0.66。
 * 这正是 `current_frozen_facts_no_volume` 那个名字的意思：**没有搜索量，并且说出来**。
 *
 * 另外五项全部来自已采到的对标页面文字，可以逐条复算：
 * 出现在几个对标里、在标题里的密度、来源是采集还是已确认事实。
 *
 * @param comparables 每个 { competitorRef, matchType, title, texts[], collectedAt }，来自冻结证据。
 */
export function createZeroPointKeywordMetricsProvider({ comparables, evidenceRef, observedAt }) {
  if (!Array.isArray(comparables) || !nonEmpty(evidenceRef) || !nonEmpty(observedAt)) {
    throw new TypeError("ZERO_POINT_KEYWORD_METRICS_INPUT_INVALID");
  }
  const pool = comparables.filter(isObject).map((item) => ({
    competitorRef: item.competitorRef,
    title: nonEmpty(item.title) ? item.title : "",
    corpus: [nonEmpty(item.title) ? item.title : "", ...(Array.isArray(item.texts) ? item.texts : [])].filter(nonEmpty).join("\n"),
    collectedAt: item.collectedAt ?? null
  }));
  const titled = pool.filter((item) => nonEmpty(item.title));
  const stamps = pool.map((item) => item.collectedAt).filter(nonEmpty).sort();
  // 时间段就是这批对标的采集窗口。动态类指标必须带 period，这里如实写采集区间，不编一个统计周期。
  const period = stamps.length === 0 ? `${observedAt}/${observedAt}` : `${stamps[0]}/${stamps.at(-1)}`;

  return async function zeroPointKeywordMetrics({ preparation }) {
    if (!isObject(preparation) || !Array.isArray(preparation.rawCandidatePool) || !nonEmpty(preparation.preparationFingerprint)) {
      throw new TypeError("ZERO_POINT_KEYWORD_METRICS_PREPARATION_INVALID");
    }
    const candidates = preparation.rawCandidatePool.map((candidate) => {
      const term = candidate.term;
      const hits = pool.filter((item) => contains(item.corpus, term));
      const titleHits = titled.filter((item) => contains(item.title, term));
      const exact = candidate.matchType === "exact_match";
      const semantic = SEMANTIC_BY_MATCH_TYPE[candidate.matchType] ?? null;
      const source = candidate.sourceRefs[0] ?? evidenceRef;
      const components = {
        semanticMatch: component({
          value: semantic, raw: { matchType: candidate.matchType }, rule: SEMANTIC_RULE,
          evidenceRef: source, observedAt
        }),
        // 同款共识和同款数量在评分里只对 exact_match 开放，别的匹配类型给了值会直接报错。
        competitorConsensus: exact && pool.length > 0 ? component({
          value: (hits.length / pool.length) * 100, raw: { hits: hits.length, comparables: pool.length },
          rule: "round4(命中对标数 / 对标总数 * 100)", evidenceRef: source, observedAt
        }) : null,
        competitorCount: exact ? component({
          value: Math.min(hits.length, 5) / 5 * 100, raw: { hits: hits.length, cap: 5 },
          rule: "round4(min(命中对标数,5) / 5 * 100)", evidenceRef: source, observedAt
        }) : null,
        titleDensity: titled.length > 0 ? component({
          value: (titleHits.length / titled.length) * 100, raw: { titleHits: titleHits.length, titles: titled.length },
          rule: "round4(标题命中数 / 有标题的对标数 * 100)", evidenceRef: source, observedAt, period
        }) : null,
        sourceTrust: component({
          value: candidate.matchType === "target_fact" ? 100 : hits.length > 0 ? 85 : 60,
          raw: { matchType: candidate.matchType, capturedHits: hits.length },
          rule: "已确认商品事实=100、在采到的对标文字里能找到=85、只在冻结证据里出现=60",
          evidenceRef: source, observedAt
        }),
        // 以下四项需要平台或第三方真实读数，本次零调用，如实留空。
        searchDemand: null, addToCartConversion: null, searchGrowth: null, returnCancelHealth: null
      };
      return {
        key: keywordMetricKey(candidate),
        descriptionGate: { approved: false, evidenceRef, reason: "零点数路径不开描述位豁免：语义分来自可比性判定，不落在70-79区间" },
        components: Object.fromEntries(Object.entries(components).filter(([, value]) => value !== null))
      };
    });
    return {
      version: ZERO_POINT_KEYWORD_METRICS_VERSION,
      evidenceRef,
      preparationFingerprint: preparation.preparationFingerprint,
      candidates
    };
  };
}
