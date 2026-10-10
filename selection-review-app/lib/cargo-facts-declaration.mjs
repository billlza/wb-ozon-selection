import { currentSalesSnapshot } from './discovery-market-snapshot.mjs';

/**
 * 运输属性 — the owner's own declaration of what this product is, for transport.
 *
 * Why this module exists. The GUOO line comparison refuses to turn a quoted freight figure into a transport
 * approval: `cargoEligibility` answers `unknown` for every line while the cargo facts are missing, so
 * `transportVerified` is false and B never opens. That gate is right — working out a price is not the same as
 * checking whether the line accepts the goods — but until now nothing anywhere let the owner state those facts,
 * so the gate closed on every product.
 *
 * The owner's ruling, 2026-09-13: 「能默认，不能替他签」.
 *   - The software may propose, but only from evidence it actually holds, and it must show and archive that
 *     evidence beside the proposal.
 *   - Where it cannot tell, it must say so and let him choose — it never guesses `none` for something whose
 *     captured attributes or title mention batteries, heating, USB, motors or remotes, and it never calls
 *     something 普货 while the captured brand field names a real brand.
 *   - What he sees is one sentence and one button, not four dropdowns; individual values stay editable.
 *   - What is saved says plainly that the owner declared it and what the software had proposed it from.
 *
 * Nothing here reads a service, writes a platform or dispatches anything. It reads saved capture evidence and
 * returns sentences; the route saves what the owner confirms.
 */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export const CARGO_FACTS_RECORD_VERSION = 'candidate-cargo-facts-v1';
export const CARGO_FACTS_PROPOSAL_VERSION = 'cargo-facts-proposal-v1';
export const CARGO_FACTS_STEP_VERSION = 'cargo-facts-step-v1';

/** The five fields `guoo-route-comparison.mjs` accepts, and nothing else. Its own validator is the contract. */
export const CARGO_FACT_KEYS = Object.freeze([
  'batteryType', 'batteryEnergyWh', 'generalCargo', 'personalUse', 'irregularShape'
]);
export const BATTERY_TYPES = Object.freeze(['none', 'installed', 'standalone', 'unknown']);

/* ── 词表 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
 * These lists decide only one thing: whether the software is allowed to propose at all. A hit never produces a
 * value — it produces 「这件我判断不了，你来选」. So the lists are deliberately wide: a false hit costs the owner one
 * click, a missed hit would let the software declare a battery product battery-free on his behalf.
 *
 * Matching: a term made only of ASCII letters matches as a whole Latin word, case-insensitively — so `led` does not
 * fire on `sled` and `Wh` does not fire on `White`, while `LED灯` and `2000mAh` still do, because the neighbour is
 * not a Latin letter. Anything else — Chinese, Russian — is a plain substring, because those stems are already
 * unambiguous.
 */

/** 带电／发热／有源的迹象。命中任何一个就不提议 batteryType，也不提议 generalCargo。 */
export const POWERED_WORDS = Object.freeze([
  '电池', '锂电', '锂离子', '纽扣电池', '蓄电', '储能', '电芯',
  '充电', '快充', '充电宝', '移动电源', '电量', '毫安', 'mAh', 'Wh', '瓦时', '伏特',
  '电动', '马达', '电机', '遥控', '插电', '通电', '电源线', '变压器', '适配器',
  '发热', '加热', '电热', '恒温', '暖手', '暖脚',
  'USB', 'TypeC', 'Type-C', '蓝牙', 'wifi', '无线充', 'LED', '灯带', '电子', '电路板',
  // 俄文商品标题里同样明确的词根；只收无歧义的，不收「электр」这类过宽的前缀。
  'аккумулятор', 'батаре', 'зарядк', 'зарядн', 'литий', 'powerbank', 'battery', 'lithium'
]);

/** 不是普货的迹象：带磁、液体、粉末、刀具、易燃。命中就不提议 generalCargo。 */
export const NON_GENERAL_CARGO_WORDS = Object.freeze([
  '磁铁', '磁性', '强磁', '磁吸', '吸铁石',
  '液体', '精油', '香水', '喷雾', '气雾', '乳液', '凝胶', '溶液', '酒精', '胶水', '油漆',
  '粉末', '粉剂', '奶粉', '颜料粉',
  '刀具', '刀片', '菜刀', '剪刀', '锐器', '针头',
  '打火机', '火柴', '易燃', '腐蚀', '压缩气'
]);

/** 异形件的迹象。命中就不提议 irregularShape。 */
export const IRREGULAR_SHAPE_WORDS = Object.freeze([
  '异形', '不规则', '雨伞', '折叠伞', '伞骨', '拉杆', '管材', '卷筒', '圆筒', '水桶', '油桶',
  '三脚架', '梯子', '球形', '滚轮', '超长', '加长杆', '整卷'
]);

/** 1688 页面上写品牌的字段名。 */
export const BRAND_ATTRIBUTE_KEYS = Object.freeze(['品牌', '商标', '品牌名称', 'brand', 'Brand']);
/** 这些值等于「没有品牌」，仿牌风险谈不上；除此之外只要写了牌子，软件就不敢说它是普货。 */
export const NO_BRAND_VALUES = Object.freeze([
  '无', '无品牌', '没有', '没有品牌', '不详', '其他', '其它', 'OEM', 'ODM', 'other', 'none', 'n/a', '-',
  '白牌', '通用', '自有品牌', '自主品牌', '无商标'
]);
/** 1688 页面上写品类的字段名；只用来把依据说成主人认得的那句话。 */
export const CATEGORY_ATTRIBUTE_KEYS = Object.freeze(['产品类别', '类别', '品类', '产品类型', '类目', '种类']);

/** 页面上给主人看的四项：标题、选项、以及不敢提议时那句「为什么要你来选」。 */
export const CARGO_FACT_FIELDS = Object.freeze([
  Object.freeze({
    field: 'batteryType', label: '带不带电',
    options: Object.freeze([
      Object.freeze({ value: 'none', label: '不带电' }),
      Object.freeze({ value: 'installed', label: '电池装在里面' }),
      Object.freeze({ value: 'standalone', label: '单独的电池' }),
      Object.freeze({ value: 'unknown', label: '我也说不准' })
    ])
  }),
  Object.freeze({
    field: 'batteryEnergyWh', label: '电池瓦时（Wh）',
    options: null
  }),
  Object.freeze({
    field: 'generalCargo', label: '是不是普货',
    options: Object.freeze([
      Object.freeze({ value: true, label: '是普货' }),
      Object.freeze({ value: false, label: '不是普货' }),
      Object.freeze({ value: null, label: '我也说不准' })
    ])
  }),
  Object.freeze({
    field: 'personalUse', label: '个人自用还是商业用',
    options: Object.freeze([
      Object.freeze({ value: true, label: '个人自用' }),
      Object.freeze({ value: false, label: '商业用途' }),
      Object.freeze({ value: null, label: '我也说不准' })
    ])
  }),
  Object.freeze({
    field: 'irregularShape', label: '是不是异形件',
    options: Object.freeze([
      Object.freeze({ value: false, label: '不是异形件' }),
      Object.freeze({ value: true, label: '是异形件' }),
      Object.freeze({ value: null, label: '我也说不准' })
    ])
  })
]);

const FIELD_LABEL = new Map(CARGO_FACT_FIELDS.map(item => [item.field, item.label]));

/** 举给主人看的样子词，和上面的词表同源，只是不把整张表念给他听。 */
const POWERED_SAMPLE = '电池／锂电／充电／发热／USB／电动／遥控';
const NON_GENERAL_SAMPLE = '带磁／液体／粉末／刀具';
const IRREGULAR_SAMPLE = '异形／伞／拉杆／卷筒';

function wordPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return /^[A-Za-z]+$/u.test(term) ? new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'iu') : new RegExp(escaped, 'iu');
}
const PATTERN_CACHE = new Map();
function matches(term, text) {
  if (!PATTERN_CACHE.has(term)) PATTERN_CACHE.set(term, wordPattern(term));
  return PATTERN_CACHE.get(term).test(text);
}

/**
 * Everything this product's saved records actually say, each piece with the place it was read from, so a hit can be
 * quoted back to the owner as 「属性「电池容量」里写着「电池」」 instead of an unattributable verdict.
 */
export function cargoFactsEvidence(candidate) {
  const capture = isObject(candidate?.sourceCapture) ? candidate.sourceCapture : null;
  const entries = [];
  const title = textOf(capture?.title);
  if (title !== null) entries.push({ where: '采到的商品标题', text: title });

  const attributes = isObject(capture?.supplierAttributes) ? capture.supplierAttributes : {};
  const attributeKeys = [];
  for (const [key, value] of Object.entries(attributes)) {
    const name = textOf(key);
    const declared = textOf(value);
    if (name === null || declared === null) continue;
    attributeKeys.push(name);
    entries.push({ where: `属性「${name}」`, text: `${name} ${declared}` });
  }

  const skus = Array.isArray(capture?.skuChoices) ? capture.skuChoices : [];
  let skuAttributeCount = 0;
  for (const sku of skus) {
    for (const [key, value] of Object.entries(isObject(sku?.attributes) ? sku.attributes : {})) {
      const name = textOf(key);
      const declared = textOf(value);
      if (name === null || declared === null) continue;
      skuAttributeCount += 1;
      entries.push({ where: `规格「${name}」`, text: `${name} ${declared}` });
    }
  }

  const snapshot = currentSalesSnapshot(candidate);
  const marketCategory = textOf(snapshot?.categoryPath) === 'unknown' ? null : textOf(snapshot?.categoryPath);
  const marketTitle = textOf(snapshot?.title);
  if (marketCategory !== null) entries.push({ where: `对标商品的类目「${marketCategory}」`, text: marketCategory });
  if (marketTitle !== null) entries.push({ where: '对标商品的标题', text: marketTitle });

  const brandKey = BRAND_ATTRIBUTE_KEYS.find(key => textOf(attributes?.[key]) !== null) ?? null;
  const brandValue = brandKey === null ? null : textOf(attributes[brandKey]);
  const brand = brandValue === null || NO_BRAND_VALUES.some(value => value.toLowerCase() === brandValue.toLowerCase())
    ? null : { key: brandKey, value: brandValue };

  const categoryKey = CATEGORY_ATTRIBUTE_KEYS.find(key => textOf(attributes?.[key]) !== null) ?? null;

  // 「一件起订」的报价：这件商品是一单一件零售发给买家，不是成箱走的商业货，这是软件手上唯一能证明它的记录。
  const singlePieceQuote = (Array.isArray(capture?.priceRanges) ? capture.priceRanges : [])
    .find(range => finite(range?.minimumQuantity) === 1) ?? null;

  const dimensions = isObject(candidate?.supplierDraftV1?.dimensionsCm) ? candidate.supplierDraftV1.dimensionsCm : {};
  const box = ['length', 'width', 'height'].every(key => (finite(dimensions[key]) ?? 0) > 0)
    ? `${dimensions.length}×${dimensions.width}×${dimensions.height} 厘米` : null;

  return Object.freeze({
    entries: Object.freeze(entries),
    readable: entries.length > 0,
    title,
    attributeCount: attributeKeys.length,
    attributeKeys: Object.freeze(attributeKeys),
    skuCount: skus.length,
    skuAttributeCount,
    category: categoryKey === null ? null : textOf(attributes[categoryKey]),
    marketCategory,
    marketTitle,
    brand: brand === null ? null : Object.freeze(brand),
    singlePieceQuoteSource: singlePieceQuote === null ? null : (textOf(singlePieceQuote.source) ?? '这次采集'),
    packedBox: box,
    offerId: textOf(capture?.offerId)
  });
}

/** Which of the read places named a listed word, quoted so the owner can check the software's reading himself. */
function hits(evidence, words) {
  const found = [];
  for (const entry of evidence.entries) {
    for (const term of words) {
      if (!matches(term, entry.text)) continue;
      found.push({ where: entry.where, term });
      break;
    }
  }
  return found;
}

/** 「属性「电池容量」里写着「电池」」；命中多处只举前两处，后面用个数带过。 */
function hitSentence(found) {
  const shown = found.slice(0, 2).map(item => `${item.where}里写着「${item.term}」`).join('，');
  return found.length > 2 ? `${shown}，另外还有 ${found.length - 2} 处` : shown;
}

/**
 * 「采到的类别「雨衣」、全部 12 项属性、6 个规格的属性、商品标题」——这句话说的是软件读了哪些地方。
 * 它必须把真读过的都点到：主人是照着这句话签字的，少说一处就等于让他以为软件看得比实际少。
 */
function readPlaces(evidence) {
  return [
    evidence.category === null ? null : `采到的类别「${evidence.category}」`,
    evidence.attributeCount === 0 ? null : `全部 ${evidence.attributeCount} 项属性`,
    evidence.skuAttributeCount === 0 ? null : `${evidence.skuCount} 个规格自己的属性`,
    evidence.title === null ? null : '商品标题',
    evidence.marketCategory === null ? null : `对标商品的类目「${evidence.marketCategory}」`,
    evidence.marketTitle === null ? null : '对标商品的标题'
  ].filter(value => value !== null).join('、');
}

const undecided = (field, why) => ({ field, label: FIELD_LABEL.get(field) ?? field, why });
const basisOf = (field, value, because) => ({ field, label: FIELD_LABEL.get(field) ?? field, value, because });

/**
 * What the software is prepared to propose, and why — or, for each field it cannot tell, why it will not.
 *
 * It proposes only `batteryType: 'none'`, `generalCargo: true`, `personalUse: true` and `irregularShape: false`:
 * the four answers that the evidence it holds can support. It never proposes the other direction — a page that
 * mentions batteries is not proof that this product has one, it is proof that the software cannot tell.
 * `batteryEnergyWh` is never proposed at all: it must be null whenever the type is `none`, and where the type is
 * undecided there is nothing to say about the energy either.
 */
export function proposeCargoFacts(candidate) {
  const evidence = cargoFactsEvidence(candidate);
  const proposal = { batteryType: null, batteryEnergyWh: null, generalCargo: null, personalUse: null, irregularShape: null };
  const basis = [];
  const open = [];

  if (!evidence.readable) {
    for (const field of ['batteryType', 'generalCargo', 'personalUse', 'irregularShape']) {
      open.push(undecided(field, '这件商品还没有采到属性和标题，软件手上没有可以依据的东西，这几项只能你自己选。'));
    }
    return Object.freeze({
      schemaVersion: CARGO_FACTS_PROPOSAL_VERSION, proposal, basis, undecided: open, headline: null,
      readPlaces: '', evidenceReadable: false
    });
  }

  const places = readPlaces(evidence);
  const powered = hits(evidence, POWERED_WORDS);
  const sensitive = hits(evidence, NON_GENERAL_CARGO_WORDS);
  const irregular = hits(evidence, IRREGULAR_SHAPE_WORDS);

  if (powered.length > 0) {
    open.push(undecided('batteryType', `${hitSentence(powered)}，软件不敢替你说这件不带电，你来选。`));
  } else {
    proposal.batteryType = 'none';
    basis.push(basisOf('batteryType', 'none', `依据${places}里没有出现${POWERED_SAMPLE}这类字样。`));
  }

  if (powered.length > 0 || sensitive.length > 0) {
    const found = powered.length > 0 ? powered : sensitive;
    open.push(undecided('generalCargo', `${hitSentence(found)}，软件不敢替你说这件是普货，你来选。`));
  } else if (evidence.brand !== null) {
    open.push(undecided('generalCargo',
      `属性「${evidence.brand.key}」写的是「${evidence.brand.value}」，不是「无」；牌子真假软件判断不了，仿牌走不了普货线路，你来选。`));
  } else {
    proposal.generalCargo = true;
    basis.push(basisOf('generalCargo', true,
      `依据${places}里没有出现${POWERED_SAMPLE}或${NON_GENERAL_SAMPLE}这类字样，采到的属性里也没有写牌子。`));
  }

  if (evidence.singlePieceQuoteSource === null) {
    open.push(undecided('personalUse', '这一次采集没有读到「一件起订」的报价，软件不敢替你说这是一单一件的个人自用件，你来选。'));
  } else {
    proposal.personalUse = true;
    basis.push(basisOf('personalUse', true,
      `依据这次采到的 1688 报价里写着起订量 1 件（来源 ${evidence.singlePieceQuoteSource}），这件商品是一单一件零售发给买家，不是成箱走的商业货。`));
  }

  if (irregular.length > 0) {
    open.push(undecided('irregularShape', `${hitSentence(irregular)}，软件不敢替你说这件不是异形件，你来选。`));
  } else if (evidence.packedBox === null) {
    open.push(undecided('irregularShape', '你在「找货」里还没有填打包的长宽高，软件没有形状可以依据，你来选。'));
  } else {
    proposal.irregularShape = false;
    basis.push(basisOf('irregularShape', false,
      `依据你在「找货」里填的打包尺寸是 ${evidence.packedBox}的方盒子，${places}里也没有出现${IRREGULAR_SAMPLE}这类字样。`));
  }

  return Object.freeze({
    schemaVersion: CARGO_FACTS_PROPOSAL_VERSION,
    proposal: Object.freeze(proposal),
    basis: Object.freeze(basis),
    undecided: Object.freeze(open),
    headline: open.length === 0 ? cargoFactsSentence(proposal) : null,
    readPlaces: places,
    evidenceReadable: true
  });
}

/** 一句人话，说的就是这五个值本身。判不定的那几项如实说成「说不准」。 */
export function cargoFactsSentence(facts) {
  const battery = { none: '不带电', installed: '电池装在里面', standalone: '是单独的电池', unknown: '带不带电说不准' };
  const energy = finite(facts?.batteryEnergyWh);
  const parts = [
    facts?.generalCargo === true ? '是普货' : facts?.generalCargo === false ? '不是普货' : '是不是普货说不准',
    battery[facts?.batteryType] ?? '带不带电说不准',
    energy === null ? null : `电池 ${energy} 瓦时`,
    facts?.irregularShape === false ? '不是异形件' : facts?.irregularShape === true ? '是异形件' : '是不是异形件说不准'
  ].filter(value => value !== null);
  const use = facts?.personalUse === true ? '按个人自用一单一件发出'
    : facts?.personalUse === false ? '按商业用品发出' : '个人自用还是商业用说不准';
  return `这件${parts.join('、')}，${use}。`;
}

/**
 * The server's own second check on what the owner sent, in the shape and the two conflict rules
 * `guoo-route-comparison.mjs` enforces. It refuses before anything is saved and names the rule it refused on;
 * the comparison's own validator then refuses again on the way in, which is the point of checking twice.
 */
export function validateOwnerCargoFactsDeclaration(input) {
  if (!isObject(input) || Object.keys(input).length !== CARGO_FACT_KEYS.length ||
      !CARGO_FACT_KEYS.every(key => Object.hasOwn(input, key))) {
    return { valid: false, errors: [{ field: null, message: '运输属性只接受这五项：带不带电、电池瓦时、是不是普货、个人自用还是商业用、是不是异形件。' }] };
  }
  const errors = [];
  if (!BATTERY_TYPES.includes(input.batteryType)) {
    errors.push({ field: 'batteryType', message: '带不带电只能是「不带电」「电池装在里面」「单独的电池」或「我也说不准」。' });
  }
  if (!(input.batteryEnergyWh === null || (finite(input.batteryEnergyWh) !== null && input.batteryEnergyWh > 0))) {
    errors.push({ field: 'batteryEnergyWh', message: '电池瓦时要么不填，要么是一个大于0的数。' });
  }
  for (const key of ['generalCargo', 'personalUse', 'irregularShape']) {
    if (!(input[key] === null || typeof input[key] === 'boolean')) {
      errors.push({ field: key, message: `${FIELD_LABEL.get(key)}只能是「是」「不是」或者不选。` });
    }
  }
  if (input.generalCargo === true && ['installed', 'standalone'].includes(input.batteryType)) {
    errors.push({ field: 'generalCargo', message: '普货和带电不能同时成立：你既说它是普货，又说它带电。' });
  }
  if (input.batteryType === 'none' && input.batteryEnergyWh !== null) {
    errors.push({ field: 'batteryEnergyWh', message: '已经说了不带电，就不能同时填电池瓦时。' });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * The record saved on the candidate. It carries the owner's five values, the sentence they add up to, and the
 * proposal and evidence the software had put in front of him — so a later reader can tell what he confirmed and
 * what the software had said, and whether the two were the same.
 */
export function buildOwnerCargoFactsRecord({ candidate, facts, declaredAt }) {
  const candidateId = textOf(candidate?.id);
  const revision = Number(candidate?.dataRevision);
  if (candidateId === null || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('CARGO_FACTS_CANDIDATE_INVALID: 这件商品没有可用的编号或数据修订号');
  }
  if (typeof declaredAt !== 'string' || !Number.isFinite(Date.parse(declaredAt))) {
    throw new Error('CARGO_FACTS_DECLARED_AT_INVALID: 确认时间无效');
  }
  const validation = validateOwnerCargoFactsDeclaration(facts);
  if (!validation.valid) {
    throw new Error(`CARGO_FACTS_INVALID: ${validation.errors.map(item => item.message).join('；')}`);
  }
  const proposed = proposeCargoFacts(candidate);
  const declared = {
    batteryType: facts.batteryType,
    batteryEnergyWh: facts.batteryEnergyWh,
    generalCargo: facts.generalCargo,
    personalUse: facts.personalUse,
    irregularShape: facts.irregularShape,
    // 来源要能追回这一次声明本身：哪件商品、哪个修订号、什么时候。
    sourceRef: `owner-cargo-facts:${candidateId}:${revision}:${declaredAt}`
  };
  return {
    schemaVersion: CARGO_FACTS_RECORD_VERSION,
    declaredBy: 'owner',
    declaredAt,
    declaredRevision: revision,
    facts: declared,
    headline: cargoFactsSentence(declared),
    proposal: { ...proposed.proposal },
    basis: proposed.basis.map(item => ({ ...item })),
    undecided: proposed.undecided.map(item => ({ ...item })),
    matchesProposal: CARGO_FACT_KEYS.every(key => proposed.proposal[key] === declared[key])
  };
}

/**
 * The declaration in exactly the closed shape `compareGuooRoutes` accepts, or null when the owner has not declared.
 * Null is today's behaviour unchanged: no facts, every line `unknown`, `transportVerified` false, B stays shut.
 * A record that is present but does not hold a lawful declaration is an error, not a silent null — reporting it
 * is the only way the owner finds out that his declaration is not the one being used.
 */
export function readDeclaredCargoFacts(candidate) {
  const record = candidate?.cargoFactsV1;
  if (record === undefined || record === null) return null;
  const facts = isObject(record) && record.schemaVersion === CARGO_FACTS_RECORD_VERSION && isObject(record.facts)
    ? record.facts : null;
  const sourceRef = textOf(facts?.sourceRef);
  if (facts === null || sourceRef === null) {
    throw new Error('CARGO_FACTS_RECORD_INVALID: 已保存的运输属性声明不是本软件写下的格式，请在「算利润」里重新确认一次运输属性。');
  }
  const declared = Object.fromEntries(CARGO_FACT_KEYS.map(key => [key, facts[key]]));
  const validation = validateOwnerCargoFactsDeclaration(declared);
  if (!validation.valid) {
    throw new Error(`CARGO_FACTS_RECORD_INVALID: 已保存的运输属性声明不合法（${
      validation.errors.map(item => item.message).join('；')}），请在「算利润」里重新确认一次运输属性。`);
  }
  return { ...declared, sourceRef };
}

/**
 * Whether the declaration is complete enough for the transport check to have anything to work with. An owner may
 * honestly answer 「我也说不准」 to any of the four; the record still saves, but B's transport check would answer
 * `unknown` and refuse — so the profit step says that here, with the button disabled, instead of letting him
 * click and collect a 422.
 */
export function cargoFactsGate(record) {
  if (record === null || record === undefined) {
    return { ready: false, reason: '还没有确认这件商品的运输属性。软件要先知道它带不带电、是不是普货，才能核验线路收不收这件货。' };
  }
  const facts = isObject(record.facts) ? record.facts : {};
  const pending = [];
  if (facts.batteryType === 'unknown') pending.push('带不带电');
  if (facts.generalCargo === null) pending.push('是不是普货');
  if (facts.personalUse === null) pending.push('个人自用还是商业用');
  if (facts.irregularShape === null) pending.push('是不是异形件');
  if (['installed', 'standalone'].includes(facts.batteryType) && facts.batteryEnergyWh === null) pending.push('电池瓦时');
  return pending.length === 0
    ? { ready: true, reason: '' }
    : { ready: false, reason: `运输属性里还有「${pending.join('」「')}」你标着说不准；线路核验用不了说不准的值，补一下再确认。` };
}

/** Everything the 算利润 step needs to show this one block: what is saved, what is proposed, and what still blocks. */
export function buildCargoFactsStep(candidate) {
  const record = isObject(candidate?.cargoFactsV1) ? candidate.cargoFactsV1 : null;
  const proposed = proposeCargoFacts(candidate);
  const gate = cargoFactsGate(record);
  return {
    schemaVersion: CARGO_FACTS_STEP_VERSION,
    candidateId: textOf(candidate?.id),
    dataRevision: Number.isSafeInteger(candidate?.dataRevision) ? candidate.dataRevision : null,
    declared: record !== null,
    declaration: record === null ? null : {
      declaredAt: record.declaredAt ?? null,
      declaredRevision: record.declaredRevision ?? null,
      headline: record.headline ?? null,
      facts: { ...record.facts },
      basis: Array.isArray(record.basis) ? record.basis.map(item => ({ ...item })) : [],
      matchesProposal: record.matchesProposal === true
    },
    proposal: { ...proposed.proposal },
    basis: proposed.basis.map(item => ({ ...item })),
    undecided: proposed.undecided.map(item => ({ ...item })),
    headline: proposed.headline,
    fields: CARGO_FACT_FIELDS.map(item => ({
      field: item.field, label: item.label,
      options: item.options === null ? null : item.options.map(option => ({ ...option }))
    })),
    gate
  };
}
