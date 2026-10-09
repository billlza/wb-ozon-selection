/**
 * 每单额外操作费 — the money this product costs to get out of the door, over and above the goods and the freight.
 *
 * Why this module exists. `candidate.packagingCostRmb` is a hard requirement of the B evidence policy
 * (`buildLifecycleBExplicitOtherCosts` refuses with `B_EVIDENCE_COST_POLICY_INCOMPLETE` while it is not a finite
 * non-negative number), and every candidate that arrives through discovery is created with it `null`
 * (`candidate-initialization.mjs`). Nothing on the new product page could set it, so the owner walked all the way to
 * the last button twice — 2026-09-14 and 2026-09-15 — and was stopped by a wall he could not climb from the page.
 *
 * The owner's ruling, 2026-09-15:
 *   - 「有时候不止一块五有时候没有，有时候不叫包材费比如说是拆单费或者合包费或者是额外材料费」 — so it is not one
 *     fixed number and not one fixed name. It is a list of lines, each with the name he gives it and its amount.
 *   - 「可以先走 0 然后我手动往上加」 — so the default is an EMPTY list, which is ¥0.00, and ¥0.00 is a declaration
 *     he signed, not a field he failed to fill in.
 *   - The software proposes and he confirms with one click, the way 运输属性 and 估算佣金授权 already work.
 *
 * What this module does NOT do: it does not change the shape of the money. `packagingCostRmb` stays the one
 * authoritative total that `lifecycle-b-input-bundle.mjs`, `profit-model.mjs`, `profit-model-calculation.mjs` and
 * `a-discovery-estimate.mjs` read; this record sits beside it and says what that total is made of. The two are held
 * together by one rule — the lines must add up to the total, to the cent — and nothing here ever writes one without
 * the other. A candidate that has a total but no lines is history, not an error: no detail, total unchanged.
 */

export const EXTRA_HANDLING_FEES_RECORD_VERSION = 'candidate-extra-handling-fees-v1';
export const EXTRA_HANDLING_FEES_STEP_VERSION = 'extra-handling-fees-step-v1';

/** What the owner calls this money. Never 「包材费用」 again: 包材 is only one of the things it can be. */
export const EXTRA_HANDLING_FEE_LABEL = '每单额外操作费';

/** Names he has actually used, offered as one-tap fills. He may type anything; these are not a closed list. */
export const EXTRA_HANDLING_FEE_NAME_SUGGESTIONS = Object.freeze(['包材', '拆单费', '合包费', '额外材料费']);

export const MAX_EXTRA_HANDLING_FEE_ITEMS = 12;
export const MAX_EXTRA_HANDLING_FEE_NAME_LENGTH = 40;
export const MAX_EXTRA_HANDLING_FEE_AMOUNT_RMB = 10_000;

/** A name is a line of text the owner typed; anything unprintable in it means the payload was not typed by him. */
const CONTROL_CHARACTER = new RegExp('[\\u0000-\\u001f\\u007f]', 'u');

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const textOf = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const money = value => `¥${value.toFixed(2)}`;

/** Cents, the same way the rest of the money in this project rounds a sum of declared amounts. */
export const centsOf = value => Math.round(value * 100) / 100;

/** The sum of the lines, to the cent. An empty list is ¥0 — the owner's default, and a real answer. */
export function extraHandlingFeesTotalRmb(items) {
  return centsOf((Array.isArray(items) ? items : [])
    .reduce((total, item) => total + (finite(item?.amountRmb) ?? Number.NaN), 0));
}

/**
 * The server's own check on what the owner sent: a list (possibly empty) of {名目, 金额} and nothing else.
 * A line worth ¥0 is refused rather than saved — a fee that costs nothing is a line he should delete, and keeping it
 * would put a name in the record that the total cannot account for.
 */
export function validateOwnerExtraHandlingFees(items) {
  if (!Array.isArray(items)) {
    return { valid: false, errors: [{ index: null, field: null, message: `${EXTRA_HANDLING_FEE_LABEL}要是一份清单；一行都没有就是 ¥0.00。` }] };
  }
  if (items.length > MAX_EXTRA_HANDLING_FEE_ITEMS) {
    return { valid: false, errors: [{ index: null, field: null, message: `${EXTRA_HANDLING_FEE_LABEL}最多 ${MAX_EXTRA_HANDLING_FEE_ITEMS} 行。` }] };
  }
  const errors = [];
  const names = new Set();
  items.forEach((item, index) => {
    if (!isObject(item) || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'name') || !Object.hasOwn(item, 'amountRmb')) {
      errors.push({ index, field: null, message: `第 ${index + 1} 行只接受「名目」和「金额」两项。` });
      return;
    }
    const name = textOf(item.name);
    if (name === null || name.length > MAX_EXTRA_HANDLING_FEE_NAME_LENGTH || CONTROL_CHARACTER.test(name)) {
      errors.push({ index, field: 'name', message: `第 ${index + 1} 行要写清楚这笔钱叫什么，比如包材、拆单费、合包费、额外材料费。` });
    } else if (names.has(name)) {
      errors.push({ index, field: 'name', message: `「${name}」写了两行；同一个名目并成一行，金额加起来。` });
    } else {
      names.add(name);
    }
    const amount = finite(item.amountRmb);
    if (amount === null || amount <= 0 || amount > MAX_EXTRA_HANDLING_FEE_AMOUNT_RMB || centsOf(amount) !== amount) {
      errors.push({ index, field: 'amountRmb',
        message: `第 ${index + 1} 行的金额要是一个大于 0、最多两位小数的数；这一笔不用花钱就把这一行删掉。` });
    }
  });
  return { valid: errors.length === 0, errors };
}

/** 一句人话，说的就是这份清单本身。空清单说的是「一分钱都不加」，不是「还没填」。 */
export function extraHandlingFeesSentence(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return `${EXTRA_HANDLING_FEE_LABEL} ¥0.00：这件商品你声明了不用另外加钱。`;
  return `${EXTRA_HANDLING_FEE_LABEL} ${money(extraHandlingFeesTotalRmb(list))}：${
    list.map(item => `${item.name} ${money(item.amountRmb)}`).join(' ＋ ')}。`;
}

/**
 * The record saved on the candidate, beside `packagingCostRmb`. The total is derived here from the lines and never
 * taken from the caller, so the record cannot be born disagreeing with the total the caller is about to write.
 */
export function buildOwnerExtraHandlingFeesRecord({ candidate, items, declaredAt }) {
  const candidateId = textOf(candidate?.id);
  const revision = Number(candidate?.dataRevision);
  if (candidateId === null || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('EXTRA_HANDLING_FEES_CANDIDATE_INVALID: 这件商品没有可用的编号或数据修订号');
  }
  if (typeof declaredAt !== 'string' || !Number.isFinite(Date.parse(declaredAt))) {
    throw new Error('EXTRA_HANDLING_FEES_DECLARED_AT_INVALID: 确认时间无效');
  }
  const validation = validateOwnerExtraHandlingFees(items);
  if (!validation.valid) {
    throw new Error(`EXTRA_HANDLING_FEES_INVALID: ${validation.errors.map(item => item.message).join('；')}`);
  }
  const lines = items.map(item => ({ name: textOf(item.name), amountRmb: item.amountRmb }));
  return {
    schemaVersion: EXTRA_HANDLING_FEES_RECORD_VERSION,
    declaredBy: 'owner',
    declaredAt,
    declaredRevision: revision,
    items: lines,
    totalRmb: extraHandlingFeesTotalRmb(lines),
    headline: extraHandlingFeesSentence(lines),
    // 来源要能追回这一次声明本身：哪件商品、哪个修订号、什么时候。
    sourceRef: `owner-extra-handling-fees:${candidateId}:${revision}:${declaredAt}`
  };
}

/**
 * The saved detail, or null when this candidate has none. A record that is present but is not a lawful declaration is
 * an error, not a silent null — the owner has to find out that the breakdown he is being shown is not his own.
 */
export function readDeclaredExtraHandlingFees(candidate) {
  const record = candidate?.extraHandlingFeesV1;
  if (record === undefined || record === null) return null;
  if (!isObject(record) || record.schemaVersion !== EXTRA_HANDLING_FEES_RECORD_VERSION ||
      textOf(record.sourceRef) === null || finite(record.totalRmb) === null) {
    throw new Error(`EXTRA_HANDLING_FEES_RECORD_INVALID: 已保存的${EXTRA_HANDLING_FEE_LABEL}明细不是本软件写下的格式，请在「算利润」里重新确认一次。`);
  }
  const validation = validateOwnerExtraHandlingFees(record.items);
  if (!validation.valid) {
    throw new Error(`EXTRA_HANDLING_FEES_RECORD_INVALID: 已保存的${EXTRA_HANDLING_FEE_LABEL}明细不合法（${
      validation.errors.map(item => item.message).join('；')}），请在「算利润」里重新确认一次。`);
  }
  const items = record.items.map(item => ({ name: textOf(item.name), amountRmb: item.amountRmb }));
  const totalRmb = extraHandlingFeesTotalRmb(items);
  if (record.totalRmb !== totalRmb) {
    throw new Error(`EXTRA_HANDLING_FEES_RECORD_INVALID: 已保存的${EXTRA_HANDLING_FEE_LABEL}明细各行加起来是 ${
      money(totalRmb)}，记录里写的合计却是 ${money(record.totalRmb)}，请在「算利润」里重新确认一次。`);
  }
  return { items, totalRmb, sourceRef: record.sourceRef, declaredAt: record.declaredAt ?? null };
}

/**
 * How the detail and the authoritative total stand to each other on this one candidate.
 *
 *   absent       — no total and no detail: the owner has not said anything yet. Not a number, not a zero.
 *   total_only   — a total with no detail: everything saved before this record existed. Not an error; the total rules.
 *   consistent   — a detail whose lines add up to the total, to the cent.
 *   inconsistent — a detail that does not: the breakdown is not about the money being charged, and must be refused.
 */
export function extraHandlingFeesConsistency(candidate) {
  const packagingCostRmb = finite(candidate?.packagingCostRmb);
  let detail = null;
  try {
    detail = readDeclaredExtraHandlingFees(candidate);
  } catch (error) {
    return { status: 'inconsistent', items: null, totalRmb: null, packagingCostRmb,
      reason: error instanceof Error ? error.message.replace(/^EXTRA_HANDLING_FEES_RECORD_INVALID: /u, '') : String(error) };
  }
  if (detail === null) {
    return packagingCostRmb === null
      ? { status: 'absent', items: null, totalRmb: null, packagingCostRmb, reason: '' }
      : { status: 'total_only', items: null, totalRmb: packagingCostRmb, packagingCostRmb, reason: '' };
  }
  if (detail.totalRmb !== packagingCostRmb) {
    return { status: 'inconsistent', items: detail.items, totalRmb: detail.totalRmb, packagingCostRmb,
      reason: `${EXTRA_HANDLING_FEE_LABEL}的明细各行加起来是 ${money(detail.totalRmb)}，这件商品记着的合计却是 ${
        packagingCostRmb === null ? '空的' : money(packagingCostRmb)}；两个数必须一致，请在「算利润」里重新确认一次。` };
  }
  return { status: 'consistent', items: detail.items, totalRmb: detail.totalRmb, packagingCostRmb, reason: '' };
}

/**
 * Whether 算利润 may be confirmed as far as this fee is concerned. Never declared is the case that used to be
 * discovered at the very last button; it is reported here, where the owner can do something about it in one click.
 */
export function extraHandlingFeesGate(candidate) {
  const consistency = extraHandlingFeesConsistency(candidate);
  if (consistency.status === 'inconsistent') return { ready: false, reason: consistency.reason };
  if (consistency.status === 'absent') {
    return { ready: false, reason: `这件商品还没声明${EXTRA_HANDLING_FEE_LABEL}——包材、拆单费、合包费、额外材料费这一类，` +
      '每单要另外花的钱。不用加钱就一键确认 ¥0.00；要加就写上名目和金额。下面的利润在你声明之前只是暂按 ¥0.00 算的。' };
  }
  return { ready: true, reason: '' };
}

/**
 * The amount this product's own money is worked out with, and whether it is a declaration or a placeholder.
 *
 * This is what replaces the project-wide ¥3 assumption on every number the owner is shown for one product. Undeclared
 * is NOT silently ¥3 and NOT silently ¥0: it is ¥0 with `declared: false`, and every place that shows it has to say
 * so. ¥3 stays only where there is no product to ask — the A-stage discovery batch estimate.
 */
export function extraHandlingFeeAssumptions(candidate) {
  const consistency = extraHandlingFeesConsistency(candidate);
  const declared = consistency.packagingCostRmb !== null && consistency.status !== 'inconsistent';
  return {
    packagingRmbDefault: declared ? consistency.packagingCostRmb : 0,
    extraHandlingDeclared: declared,
    extraHandlingStatus: consistency.status
  };
}

/** Everything 算利润 needs to show this one block: what is saved, what one click would save, and what still blocks. */
export function buildExtraHandlingFeesStep(candidate) {
  const consistency = extraHandlingFeesConsistency(candidate);
  const gate = extraHandlingFeesGate(candidate);
  const record = isObject(candidate?.extraHandlingFeesV1) ? candidate.extraHandlingFeesV1 : null;
  return {
    schemaVersion: EXTRA_HANDLING_FEES_STEP_VERSION,
    candidateId: textOf(candidate?.id),
    dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    label: EXTRA_HANDLING_FEE_LABEL,
    status: consistency.status,
    declared: consistency.status === 'consistent' || consistency.status === 'total_only',
    totalRmb: consistency.packagingCostRmb,
    items: consistency.items === null ? [] : consistency.items.map(item => ({ ...item })),
    declaredAt: consistency.status === 'consistent' ? (record?.declaredAt ?? null) : null,
    declaredRevision: consistency.status === 'consistent' ? (record?.declaredRevision ?? null) : null,
    headline: consistency.status === 'consistent' ? extraHandlingFeesSentence(consistency.items)
      : consistency.status === 'total_only'
        ? `${EXTRA_HANDLING_FEE_LABEL} ${money(consistency.packagingCostRmb)}：这个合计是早先存下来的，没有留下它由哪几笔组成。`
        : null,
    // 空清单就是提议本身：默认 ¥0，主人一键确认就过，不用打字。
    proposal: { items: [], totalRmb: 0, headline: extraHandlingFeesSentence([]) },
    nameSuggestions: [...EXTRA_HANDLING_FEE_NAME_SUGGESTIONS],
    maxItems: MAX_EXTRA_HANDLING_FEE_ITEMS,
    gate
  };
}
