/**
 * 「做这件」卡上的品牌与权利声明。
 *
 * 品牌与权利必须在付费写文案之前签：签晚了，已经写好的文案会随旧的 C1 计划一起作废（lib/c1-sku-rights-review-submission.mjs
 * 的替代计划）。可签的那一刻，这件商品还没有规格，也还没有 C1 计划，声明没处挂。所以主人在「做这件」卡上声明的是这件商品
 * 本身（不论最后上哪个规格），存成一份独立记录（gate1RightsDeclarationV1）；等规格定下、C1 计划生成，软件按「做这件」的
 * 许可把这份声明原样记成这件商品的权利评审记录（c1RightsReviewRecord），声明人仍是主人，内容一字不改。
 *
 * 只收能让商品往下走的声明：品牌是明确无品牌或有品牌（带名称），权利是自有、已获许可、或无品牌且未发现第三方权利。
 * 还没核实的不存，到时候软件停下等主人在商品页上声明，和以前一样。重新做一轮关口 1（换货源、改售价）这份声明就不再算数。
 */
export const GATE1_RIGHTS_DECLARATION_SCHEMA_VERSION = 'gate1-rights-declaration-v1';
export const GATE1_RIGHTS_INPUT_KEYS = Object.freeze(['brandStatus', 'brandName', 'rights', 'validMonths']);
export const GATE1_RIGHTS_VALID_MONTHS = Object.freeze([3, 6, 12]);
export const GATE1_RIGHTS_DEFAULT_MONTHS = 12;
export const GATE1_RIGHTS_BRANDS = Object.freeze({ unbranded: '明确无品牌', branded: '有品牌' });
export const GATE1_RIGHTS_CHOICES = Object.freeze({
  no_third_party_rights_identified: Object.freeze({ status: 'verified', basis: 'no_third_party_rights_identified', label: '已核对，未发现第三方权利' }),
  owned: Object.freeze({ status: 'verified', basis: 'owned', label: '我拥有所需权利' }),
  licensed: Object.freeze({ status: 'verified', basis: 'licensed', label: '我已获得所需许可' })
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** 卡上那一组选择有什么问题；没有问题返回 null。只看形状和搭配，服务端和页面用同一套。 */
export function gate1RightsInputProblem(input) {
  if (!isObject(input) || Object.keys(input).some(key => !GATE1_RIGHTS_INPUT_KEYS.includes(key))) {
    return { code: 'gate1_rights_invalid', message: '品牌与权利声明只收品牌、品牌名称、权利情况和有效期' };
  }
  if (!Object.hasOwn(GATE1_RIGHTS_BRANDS, input.brandStatus)) return { code: 'gate1_rights_invalid', message: '品牌只能选明确无品牌或有品牌' };
  if (input.brandStatus === 'branded') {
    const name = typeof input.brandName === 'string' ? input.brandName.trim() : '';
    if (!name || name.length > 256 || /\p{Cc}/u.test(name)) return { code: 'gate1_rights_brand_name', message: '有品牌时写上准确的品牌名称' };
  } else if (input.brandName !== undefined && input.brandName !== null && input.brandName !== '') {
    return { code: 'gate1_rights_invalid', message: '明确无品牌时不带品牌名称' };
  }
  if (!Object.hasOwn(GATE1_RIGHTS_CHOICES, input.rights)) return { code: 'gate1_rights_invalid', message: '权利情况只能选自有、已获许可，或无品牌且未发现第三方权利' };
  if (input.rights === 'no_third_party_rights_identified' && input.brandStatus !== 'unbranded') {
    return { code: 'gate1_rights_mismatch', message: '「未发现第三方权利」只适用于明确无品牌的商品' };
  }
  if (!GATE1_RIGHTS_VALID_MONTHS.includes(input.validMonths)) return { code: 'gate1_rights_invalid', message: '有效期只能选 3 个月、6 个月或一年' };
  return null;
}

function addMonths(at, months) {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

/** 存下来的那一份。和那一次「做这件」绑在一起：核对时间就是点下去的那一刻，有效期从那一刻算。 */
export function buildGate1RightsDeclaration({ candidateId, sourceRevision, input, decision, declaredByUserId, declaredAt }) {
  const problem = gate1RightsInputProblem(input);
  if (problem) throw new Error(`GATE1_RIGHTS_DECLARATION_INVALID: ${problem.code}`);
  if (typeof candidateId !== 'string' || !candidateId || !Number.isSafeInteger(sourceRevision) || decision?.decision !== 'accept' ||
      !instant(decision.decidedAt) || typeof declaredByUserId !== 'string' || !declaredByUserId.trim() || !instant(declaredAt)) {
    throw new Error('GATE1_RIGHTS_DECLARATION_INVALID: binding');
  }
  const choice = GATE1_RIGHTS_CHOICES[input.rights];
  return Object.freeze({
    schemaVersion: GATE1_RIGHTS_DECLARATION_SCHEMA_VERSION,
    declarationId: `gate1-rights:${candidateId}:${sourceRevision}`,
    candidateId,
    sourceRevision,
    gate1DecidedAt: decision.decidedAt,
    gate1RoundIndex: decision.roundIndex ?? 0,
    scope: 'this_product_any_spec',
    brand: Object.freeze({ status: input.brandStatus, name: input.brandStatus === 'branded' ? input.brandName.trim() : null }),
    rights: Object.freeze({ status: choice.status, basis: choice.basis }),
    validMonths: input.validMonths,
    reviewedAt: declaredAt,
    expiresAt: addMonths(declaredAt, input.validMonths),
    declaredByUserId,
    declaredAt
  });
}

/**
 * 这份声明现在还能不能用：同一次「做这件」、声明人和内容完整、在有效期内（给了 observedAt 才查时间）。
 * 能用返回声明本身，不能用返回 null。
 */
export function gate1RightsDeclarationCurrent(candidate, observedAt = null) {
  const declaration = candidate?.gate1RightsDeclarationV1;
  if (!isObject(declaration) || declaration.schemaVersion !== GATE1_RIGHTS_DECLARATION_SCHEMA_VERSION ||
      declaration.candidateId !== candidate.id || typeof declaration.declaredByUserId !== 'string' || !declaration.declaredByUserId.trim()) return null;
  const decision = candidate.gate1DecisionV1;
  if (decision?.decision !== 'accept' || decision.decidedAt !== declaration.gate1DecidedAt) return null;
  if (!Object.hasOwn(GATE1_RIGHTS_BRANDS, declaration.brand?.status) || declaration.rights?.status !== 'verified' ||
      !Object.values(GATE1_RIGHTS_CHOICES).some(choice => choice.basis === declaration.rights.basis) ||
      (declaration.rights.basis === 'no_third_party_rights_identified' && declaration.brand.status !== 'unbranded')) return null;
  if (!instant(declaration.reviewedAt) || !instant(declaration.expiresAt) || Date.parse(declaration.reviewedAt) >= Date.parse(declaration.expiresAt)) return null;
  if (observedAt !== null) {
    const at = Date.parse(observedAt);
    if (!Number.isFinite(at) || at < Date.parse(declaration.reviewedAt) || at >= Date.parse(declaration.expiresAt)) return null;
  }
  return declaration;
}

/** 记成 C1 权利评审时主人的那份声明：品牌、权利、核对时间和有效期，原样照抄。 */
export function gate1RightsOwnerDeclaration(declaration) {
  return {
    brand: { status: declaration.brand.status, name: declaration.brand.name },
    rights: { status: declaration.rights.status, basis: declaration.rights.basis },
    reviewedAt: declaration.reviewedAt,
    expiresAt: declaration.expiresAt
  };
}

/** 一句话说清楚存下的是什么，给「做这件」之后的那一行和商品页用。 */
export function gate1RightsLine(declaration) {
  if (!isObject(declaration)) return null;
  const brand = declaration.brand?.status === 'branded' ? `有品牌「${declaration.brand.name}」` : GATE1_RIGHTS_BRANDS[declaration.brand?.status];
  const rights = Object.values(GATE1_RIGHTS_CHOICES).find(choice => choice.basis === declaration.rights?.basis)?.label;
  if (!brand || !rights) return null;
  return `品牌与权利：${brand}，${rights}，${declaration.validMonths === 12 ? '一年' : `${declaration.validMonths} 个月`}内有效`;
}
