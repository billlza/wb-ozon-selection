import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_COLUMNS, DECLINE_REASONS, FEED_SORTS, ROUND_ALREADY_RUNNING_MESSAGE, boardColumnKey, boardColumns, deskCounts,
  deskErrorMessage, feedRows, formatInstant, freightShare, inboxItems, myProductRows, newRoundPlan, pointsLine,
  shortProductTitle, sortFeedRows, storeLabel, eliminatedRows, lastRoundUndecidedRows, ownerAttentionReasons,
  ROUND_REOPEN_WINDOW_MS } from '../src/selectionDeskView.js';
import { ROUND_RESUMABLE_WINDOW_MS } from '../lib/a-discovery-runtime-services.mjs';

// Everything below is synthetic display data written in this file: no saved records, no services, no requests.
const product = (productId, extra = {}) => ({ productId, title: `Explicitly synthetic ${productId}`,
  productUrl: `https://www.ozon.ru/product/${productId}`, imageUrl: `https://ir.ozone.ru/s3/synthetic/${productId}.jpg`,
  price: 900, salesCount: 12, revenue: 4000, reviewCount: 4, reviewRating: 4.5,
  categoryPath: { cnTitlePath: '家居 > 收纳' }, ...extra });

const estimate = (outcome, extra = {}) => ({
  status: outcome === 'selectable' ? 'ok' : outcome === 'excluded_negative' ? 'negative' : 'incomplete',
  outcome, summary: '合成估算摘要', maximumAllInPurchaseRmb: null,
  freight: { route: null, chargeableKg: null, freightRmb: null, oversize: false }, commissionRate: 0.14, ...extra });

const batchEntry = ({ batchId = 'a-discovery-batch:synthetic', revision = 0, targetStore = 'miska', products = [],
  selections = [], importedCandidates = [], declines = [], createdAt = '2026-09-09T04:00:00.000Z',
  direction = '普通非电桌面整理小件（合成）', jobStatus = 'completed', remainingPoints = null } = {}) => ({
  batch: { batchId, revision, targetStore, createdAt, plan: { provider: 'seerfar', direction } },
  jobs: [
    { job: { status: jobStatus, scopeBinding: { request: { method: 'category_detail' } } },
      receipt: { steps: [{ method: 'category_detail', result: { products } }] } },
    ...(remainingPoints === null ? [] : [{ job: { status: 'completed', scopeBinding: { request: { method: 'quota' } } },
      receipt: { steps: [{ method: 'quota', result: { remainingPoints } }] } }])
  ],
  selections, importedCandidates, declines });

const viewOf = (...batches) => ({ schemaVersion: 'a-discovery-view-v1', batches, targetStores: ['miska', 'dandanshu'] });

const candidate = (id, extra = {}) => ({ id, productName: `合成商品 ${id}`, targetStore: 'miska',
  workflowStatus: 'codex_processing', displayStatus: 'codex_processing', imageUrl: '', needsFromUser: [],
  updatedAt: '2026-09-09T04:00:00.000Z', createdAt: '2026-09-09T04:00:00.000Z', ...extra });

test('本店的待决定商品、自动排除和你已排除分成三份，已建卡的商品只给查看入口', () => {
  const view = viewOf(batchEntry({ products: [
    product('2107989735', { estimate: estimate('selectable', { maximumAllInPurchaseRmb: 120.5 }) }),
    product('2107989736', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -3.2 }) }),
    product('2107989737', { estimate: estimate('needs_data') }),
    product('2107989738')
  ], importedCandidates: [{ marketProductId: '2107989738', candidateId: 'candidate:synthetic' }],
    declines: [{ marketProductId: '2107989737', reason: '尺寸太大' }] }));
  const feed = feedRows(view, 'miska');
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989735', '2107989738']);
  assert.deepEqual(feed.excluded.map(row => row.marketProductId), ['2107989736']);
  assert.deepEqual(feed.declined.map(row => ({ id: row.marketProductId, reason: row.declineReason })),
    [{ id: '2107989737', reason: '尺寸太大' }]);
  assert.equal(feed.rows[1].importedCandidateId, 'candidate:synthetic');
  assert.equal(feed.direction, '普通非电桌面整理小件（合成）');
  assert.equal(feed.storeLabel, storeLabel('miska'));
  assert.equal(feed.estimable, 4);
  // Only the untranslated titles are counted; the button label uses this number.
  assert.equal(feed.pendingTranslations, 4);
  assert.equal(feedRows(view, 'miska').rows[0].titleZh, null);
});

test('中文标题、图片和事实只来自已保存结果，缺的就留空', () => {
  const view = viewOf(batchEntry({ products: [
    product('2107989735', { titleZh: '合成收纳盒', imageUrl: 'https://images.example.test/blocked.png' }),
    product('2107989736', { salesCount: null, reviewCount: null, reviewRating: null, categoryPath: null })
  ] }));
  const [first, second] = feedRows(view, 'miska').rows;
  assert.equal(first.titleZh, '合成收纳盒');
  assert.equal(first.imageUrl, '', '只有 Ozon 图片来源会被显示');
  assert.equal(first.categoryZh, '家居 > 收纳');
  assert.equal(second.titleZh, null);
  assert.deepEqual([second.salesCount, second.reviewCount, second.reviewRating, second.categoryZh], [null, null, null, null]);
  assert.deepEqual(second.chips, ['待估算', '类目未知']);
  assert.equal(feedRows(view, 'miska').pendingTranslations, 1);
});

test('三种排序都把没有数字的商品放在最后', () => {
  const rows = feedRows(viewOf(batchEntry({ products: [
    product('2107989735', { salesCount: 5, estimate: estimate('selectable', { maximumAllInPurchaseRmb: 50,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 50, oversize: false } }) }),
    product('2107989736', { salesCount: 90, estimate: estimate('selectable', { maximumAllInPurchaseRmb: 300,
      freight: { route: 'GUOO Economy Small', chargeableKg: 0.7, freightRmb: 100, oversize: true } }) }),
    product('2107989737', { salesCount: null })
  ] })), 'miska').rows;
  const ids = sort => sortFeedRows(rows, sort).map(row => row.marketProductId);
  assert.deepEqual(ids('profit'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(ids('sales'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(ids('freight'), ['2107989736', '2107989735', '2107989737']);
  assert.deepEqual(FEED_SORTS.map(option => option.value), ['profit', 'sales', 'freight']);
  assert.equal(freightShare({ maximumAllInPurchaseRmb: 300, freight: { freightRmb: 100 } }), 0.25);
  assert.equal(freightShare({ maximumAllInPurchaseRmb: null, freight: { freightRmb: 100 } }), null);
  assert.equal(freightShare(null), null);
  assert.deepEqual(rows.find(row => row.marketProductId === '2107989736').chips, ['超抛']);
});

test('店铺切换同时过滤查询结果和商品，未完成的查询不进入待决定', () => {
  const view = viewOf(
    batchEntry({ products: [product('2107989735')] }),
    batchEntry({ batchId: 'a-discovery-batch:other', targetStore: 'dandanshu', products: [product('2107989736')] }),
    batchEntry({ batchId: 'a-discovery-batch:running', products: [product('2107989739')], jobStatus: 'queued' })
  );
  assert.deepEqual(feedRows(view, 'miska').rows.map(row => row.marketProductId), ['2107989735']);
  assert.deepEqual(feedRows(view, 'dandanshu').rows.map(row => row.marketProductId), ['2107989736']);
  assert.deepEqual(feedRows(view, 'wb').rows, []);
  assert.equal(feedRows(null, 'miska').direction, null);
  const candidates = [candidate('candidate:1'), candidate('candidate:2', { targetStore: 'dandanshu' })];
  assert.deepEqual(deskCounts({ discoveryView: view, candidates, store: 'miska' }), { desk: 1, board: 1, inbox: 0 });
  assert.deepEqual(deskCounts({ discoveryView: view, candidates, store: 'wb' }), { desk: 0, board: 0, inbox: 0 });
});

test('五列进行中按业务阶段归位，已淘汰不出现，等你一行来自已保存的缺口', () => {
  const candidates = [
    candidate('candidate:a', { executionRuntime: { businessPhase: 'A' }, needsFromUser: ['补一个1688链接', '补重量'] }),
    candidate('candidate:b', { executionRuntime: { businessPhase: 'B', status: 'running' } }),
    candidate('candidate:c', { executionRuntime: { businessPhase: 'C1', status: 'queued' }, workflowStatus: 'listing_preparation' }),
    candidate('candidate:d', { executionRuntime: { businessPhase: 'D', status: 'waiting_owner' }, workflowStatus: 'ready_to_list' }),
    candidate('candidate:e', { workflowStatus: 'listed', displayStatus: 'listed' }),
    candidate('candidate:x', { workflowStatus: 'eliminated' })
  ];
  const columns = boardColumns(candidates, 'miska');
  assert.deepEqual(columns.map(column => column.title), ['找货', '待确认', '准备中', '待上架', '在售']);
  assert.deepEqual(columns.map(column => column.title), BOARD_COLUMNS.map(column => column.title));
  assert.deepEqual(columns.map(column => column.cards.map(card => card.id)),
    [[], ['candidate:a'], ['candidate:b', 'candidate:c'], ['candidate:d'], ['candidate:e']]);
  // 「等你」一行和「需要你处理」用同一个判断、同一句话。
  assert.equal(columns[1].cards[0].waitingLine, inboxItems(candidates, 'miska')[0].need);
  assert.equal(columns[2].cards[0].waitingLine, null);
  // 一套说法：不再出现旧系统的「选品处理」「上架前确认」。
  assert.deepEqual(columns.slice(2).flatMap(column => column.cards.map(card => card.statusLine)), ['软件在做', '排着等软件', '等你决定', '已上架']);
  // A candidate that never carried a saved phase still lands somewhere the owner can find it.
  assert.equal(boardColumnKey(candidate('candidate:n', { workflowStatus: 'needs_user_data' })), 'confirm');
  assert.equal(boardColumnKey(candidate('candidate:l', { workflowStatus: 'listed', executionRuntime: { businessPhase: 'B' } })), 'live');
});

test('进行中：录入还在找的在「找货」，找完等「做这件」的和正式利润没过线的在「待确认」，也都在「需要你处理」', () => {
  const candidates = [
    candidate('candidate:q', { workflowStatus: 'awaiting_user_direction', intake: { stage: 'queued', sourceKind: 'pinduoduo' } }),
    candidate('candidate:r', { workflowStatus: 'awaiting_user_direction', intake: { stage: 'ready', sourceKind: 'pinduoduo' },
      roughProfit: { status: 'ok', profitPerUnitRmb: 12, passes: true } }),
    candidate('candidate:f', { workflowStatus: 'awaiting_user_direction', intake: { stage: 'ready', sourceKind: 'pinduoduo' },
      executionRuntime: { businessPhase: 'B', status: 'completed' }, gate1: { decision: 'accept' },
      gate1DecisionV1: { decision: 'accept' }, supplierDraftV1: { schemaVersion: 'supplier-draft-v1' },
      gate1ShortfallV1: { unitProfitRmb: 1.2, shortfallRmb: 4.8, resolvedAt: null } }),
    candidate('candidate:old', { workflowStatus: 'codex_processing' })
  ];
  const columns = boardColumns(candidates, 'miska');
  assert.deepEqual(columns[0].cards.map(card => card.id), ['candidate:q']);
  assert.deepEqual(columns[1].cards.map(card => card.id).sort(), ['candidate:f', 'candidate:old', 'candidate:r']);
  const byId = new Map(columns[1].cards.map(card => [card.id, card]));
  assert.equal(byId.get('candidate:r').statusLine, '找完了，等你点「做这件」');
  assert.equal(byId.get('candidate:r').roughProfit.label, '粗算 约 ¥12.00/件');
  assert.equal(byId.get('candidate:f').statusLine, '正式利润没过线');
  assert.match(byId.get('candidate:f').waitingLine, /离门槛还差每件 ¥4\.80.*换货源、改售价，或者不做/u);
  // 老商品没走录入、也没决定过：不算在等主人，不涌进「需要你处理」。
  assert.equal(byId.get('candidate:old').statusLine, '还没决定做不做');
  assert.equal(byId.get('candidate:old').waitingLine, null);
  const inbox = inboxItems(candidates, 'miska');
  assert.deepEqual(inbox.map(item => item.id).sort(), ['candidate:f', 'candidate:r']);
  const ready = inbox.find(item => item.id === 'candidate:r');
  assert.deepEqual(ready.reasons, ['找完了，看同款、货源和粗算，决定做不做这件']);
  assert.deepEqual(ready.action, { key: 'open', label: '去确认' });
  assert.equal(inbox.find(item => item.id === 'candidate:f').action.label, '去选怎么办');
});

test('进行中把卡住的显示出来：排队第几、整条队停着、插件没连上、停在哪一步、没货源、B 之后的技术停下', () => {
  const intake = stage => ({ stage, sourceKind: 'pinduoduo' });
  const candidates = [
    candidate('candidate:q1', { workflowStatus: 'awaiting_user_direction', intake: intake('queued') }),
    candidate('candidate:q2', { workflowStatus: 'awaiting_user_direction', intake: intake('reading_source') }),
    candidate('candidate:gone', { workflowStatus: 'awaiting_user_direction', intake: { stage: 'blocked', sourceKind: 'pinduoduo',
      blocker: { code: 'source_delisted', scope: 'item', retryable: false, message: '货源已经下架了，换一个货源，或者不做这件' } } }),
    candidate('candidate:late', { workflowStatus: 'awaiting_user_direction', intake: { stage: 'blocked', sourceKind: 'pinduoduo',
      blocker: { code: 'presale_too_late', scope: 'item', retryable: false, message: '货源是预售，发货比店铺档案里允许的晚' } } }),
    candidate('candidate:nosrc', { workflowStatus: 'codex_processing' }),
    candidate('candidate:ext', { executionRuntime: { businessPhase: 'C1', status: 'blocked', technicalFailure: { kind: 'external_dependency' } } }),
    candidate('candidate:unk', { executionRuntime: { businessPhase: 'D', status: 'blocked', technicalFailure: { kind: 'unknown_outcome' } } }),
    candidate('candidate:exc', { executionRuntime: { businessPhase: 'B', status: 'blocked', exceptionCase: { status: 'open' } } })
  ];
  const queue = { items: [
    { candidateId: 'candidate:q1', stage: 'queued', queue: { position: 2, total: 3 }, batch: { position: 3, total: 8 } },
    { candidateId: 'candidate:q2', stage: 'reading_source', queue: null, batch: null }
  ], pause: { code: 'slider_required', message: '要你在自己的 Chrome 里拖一下滑块，过了再点「接着找」' }, extension: { online: true } };
  const cards = new Map(boardColumns(candidates, 'miska', { intakeQueue: queue }).flatMap(column => column.cards).map(card => [card.id, card]));
  assert.equal(cards.get('candidate:q1').positionLine, '第 3 / 8 条 · 排第 2 / 3');
  assert.equal(cards.get('candidate:q1').statusLine, '排队中');
  assert.match(cards.get('candidate:q1').stuckLine, /^整条队先停着：要你在自己的 Chrome 里拖一下滑块/u);
  assert.equal(cards.get('candidate:q2').statusLine, '正在读货源页');
  assert.equal(cards.get('candidate:q2').stuck, true);
  // 卡住的给一个按钮：整条队停着点「接着找」，在等你的点「去处理」。
  assert.deepEqual(cards.get('candidate:q1').action, { key: 'resume', label: '接着找' });
  assert.deepEqual(cards.get('candidate:gone').action, { key: 'open', label: '去处理' });
  assert.equal(cards.get('candidate:ext').action, null);
  // 没连上插件、没有整页暂停时，在跑的说插件没连上。
  const offline = boardColumns(candidates, 'miska', { intakeQueue: { ...queue, pause: null, extension: { online: false } } })[0].cards;
  assert.equal(offline.find(card => card.id === 'candidate:q2').stuckLine, '插件没连上，这件排着等，什么都不会丢');
  // 停下来的：等你那一行已经说了原因，卡仍标成卡住。
  assert.equal(cards.get('candidate:gone').stuck, true);
  assert.match(cards.get('candidate:gone').waitingLine, /^货源已经下架了/u);
  assert.equal(cards.get('candidate:late').stuckLine, '货源是预售，发货比店铺档案里允许的晚');
  const retry = boardColumns([candidate('candidate:unread', { workflowStatus: 'awaiting_user_direction', dataRevision: 7,
    intake: { stage: 'blocked', sourceKind: 'pinduoduo', blocker: { code: 'unknown_outcome', scope: 'item', retryable: true, message: '没等到结果' } } })], 'miska');
  assert.deepEqual(retry[0].cards[0].action, { key: 'retry', label: '核实', dataRevision: 7 });
  assert.equal(cards.get('candidate:nosrc').stuckLine, '没有货源：还没有货源');
  assert.equal(cards.get('candidate:ext').stuckLine, '外部服务不可用，已停下');
  assert.equal(cards.get('candidate:unk').stuckLine, '结果未知，要先核对，不会自动重做');
  assert.equal(cards.get('candidate:exc').stuckLine, '需要技术维护，异常已记下');
  // 不在跑、没卡住的，不标卡住。
  const calm = boardColumns([candidate('candidate:ok', { executionRuntime: { businessPhase: 'C1', status: 'running' } })], 'miska');
  assert.equal(calm[2].cards[0].stuck, false);
});

test('进行中的名字先用中文，同一件货的几个颜色合成一张卡，不另算价', () => {
  const choices = [{ sourceSkuId: '11', attributes: { 颜色: '卡其' } }, { sourceSkuId: '12', attributes: { 颜色: '黑色' } },
    { sourceSkuId: '13', attributes: { 颜色: '粉色' } }];
  const parent = candidate('candidate:vest', { productName: 'Жилет для кошки', executionRuntime: { businessPhase: 'C1', status: 'running' },
    sourceCapture: { title: '猫咪背心 宠物衣服', selectedSkuIds: ['11'], skuChoices: choices } });
  const sibling = (id, sku, runtime) => candidate(id, { productName: `原商品同款：Жилет · 供应商原色 x · SKU ${sku}`,
    siblingSourceV1: { parentCandidateId: 'candidate:vest', supplierSkuId: sku, salesSnapshotId: 'snapshot:parent' },
    sourceCapture: { title: '猫咪背心 宠物衣服', selectedSkuIds: [], skuChoices: choices }, executionRuntime: runtime });
  const candidates = [parent,
    sibling('candidate:black', '12', { businessPhase: 'C1', status: 'blocked', technicalFailure: { kind: 'known_technical_failure' } }),
    sibling('candidate:pink', '13', { businessPhase: 'D', status: 'waiting_owner' }),
    candidate('candidate:ru', { productName: 'Органайзер', sourceCapture: { title: '桌面收纳盒' } }),
    candidate('candidate:translated', { productName: 'Коврик', aDiscoveryEvidenceV2: { marketProductId: '2107989735' } })];
  const view = viewOf(batchEntry({ products: [product('2107989735', { titleZh: '合成中文标题' })] }));
  const columns = boardColumns(candidates, 'miska', { discoveryView: view });
  const copy = columns.find(column => column.key === 'prepare');
  assert.equal(copy.count, 2, '列上的数字数的是商品，不是卡');
  assert.equal(copy.cards.length, 1);
  const vest = copy.cards[0];
  assert.equal(vest.id, 'candidate:vest');
  assert.equal(vest.title, '猫咪背心 宠物衣服');
  assert.deepEqual(vest.members, [{ id: 'candidate:vest', dataRevision: null, label: '卡其', statusLine: '软件在做' },
    { id: 'candidate:black', dataRevision: null, label: '黑色', statusLine: '已停下' }]);
  assert.equal(vest.stuckLine, '黑色：技术失败，已安全停下');
  assert.equal(vest.elsewhereLine, '同一件货另有颜色在：待上架 1 个');
  const pink = columns.find(column => column.key === 'publish').cards[0];
  assert.equal(pink.title, '猫咪背心 宠物衣服');
  assert.equal(pink.elsewhereLine, '同一件货另有颜色在：准备中 2 个');
  // 卡上不显示价格：各色按原商品定价时的那份销售快照算，不在这里另算。
  assert.equal(JSON.stringify(columns).includes('₽'), false);
  const titles = new Map(columns.flatMap(column => column.cards).map(card => [card.id, card.title]));
  assert.equal(titles.get('candidate:ru'), '桌面收纳盒');
  assert.equal(titles.get('candidate:translated'), '合成中文标题');
});

test('需要你处理只列出真的在等你的商品，并保留其余缺口数量', () => {
  const candidates = [
    candidate('candidate:a', { needsFromUser: ['补一个1688链接', '补重量'] }),
    candidate('candidate:b', { needsFromUser: [] }),
    candidate('candidate:c', { needsFromUser: ['确认最终素材'], workflowStatus: 'listing_preparation', displayStatus: 'listing_preparation' }),
    candidate('candidate:x', { workflowStatus: 'eliminated', needsFromUser: ['已淘汰不该出现'] })
  ];
  const items = inboxItems(candidates, 'miska');
  assert.deepEqual(items.map(item => item.id), ['candidate:a', 'candidate:c']);
  // Owner feedback 2026-09-11: a row has to say what it is waiting for, read from this product's own records —
  // 找货 not filled in yet comes first, then the platform's own asks, in that order.
  assert.deepEqual(items[0], { id: 'candidate:a', dataRevision: null, title: '合成商品 candidate:a', imageUrl: '',
    storeLabel: 'Miska', statusLine: '待确认 · 还没决定做不做', family: 'candidate:a', colour: null, need: '找货还没填', moreNeeds: 2,
    reasons: ['找货还没填', '补一个1688链接', '补重量'], action: { key: 'draft', label: '去填找货' } });
  assert.equal(items[1].moreNeeds, 1);
  assert.equal(items[1].statusLine, '准备中 · 状态还没记录');
});

test('点数一行和查询时间只在已保存结果里有时才出现，不要的理由固定五个', () => {
  assert.equal(pointsLine(viewOf(batchEntry({ products: [product('2107989735')], remainingPoints: 85 })), 'miska'), '本店查询点数还剩 85');
  assert.equal(pointsLine(viewOf(batchEntry({ products: [product('2107989735')] })), 'miska'), null);
  assert.equal(pointsLine(null, 'miska'), null);
  assert.equal(formatInstant('not-a-time'), null);
  assert.equal(formatInstant(null), null);
  assert.match(feedRows(viewOf(batchEntry({ products: [product('2107989735')] })), 'miska').queriedAt, /^2026-09-0\d \d{2}:\d{2}$/u);
  assert.deepEqual(DECLINE_REASONS, ['尺寸太大', '利润太薄', '品牌风险', '不想做这类', '其他']);
  assert.equal(DECLINE_REASONS.every(reason => reason.length <= 40), true);
});

test('newRoundPlan explains one click before anything is created and refuses when a round is running or unconfigured', async () => {
  const { newRoundPlan } = await import('../src/selectionDeskView.js');
  const plan = { planId: 'plan:x', version: 'version:1', direction: '宠物躺床', budget: { maxCredits: 20, estimatedPointsByStep: { quota_before: 0, category_detail: 13, quota_after: 0 } } };
  const binding = { bindingId: 'binding:x', configurationVersion: 'version:1' };
  const base = { canPrepare: true, plans: [plan], bindings: [binding], batches: [] };
  const ready = newRoundPlan(base, 'miska', Date.parse('2026-09-11T00:00:00Z'));
  assert.equal(ready.ready, true); assert.equal(ready.estimatedPoints, 13); assert.equal(ready.maxCredits, 20); assert.equal(ready.warning, null); assert.equal(ready.direction, '宠物躺床');
  const recent = { ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-10T06:15:00Z', batchId: 'b', revision: 0, plan }, jobs: [{ job: { status: 'completed', completedAt: '2026-09-10T06:15:56Z', scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] };
  assert.match(newRoundPlan(recent, 'miska', Date.parse('2026-09-11T00:00:00Z')).warning, /再查会再扣一次点数/);
  assert.equal(newRoundPlan(recent, 'miska', Date.parse('2026-09-13T00:00:00Z')).warning, null);
  const running = { ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-11T00:00:00Z', batchId: 'b', revision: 0, plan }, jobs: [{ job: { status: 'claimed', completedAt: null, scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] };
  assert.equal(newRoundPlan(running, 'miska').ready, false); assert.match(newRoundPlan(running, 'miska').reason, /在进行/);
  assert.equal(newRoundPlan({ ...base, canPrepare: false }, 'miska').ready, false);
  assert.equal(newRoundPlan({ ...base, bindings: [] }, 'miska').ready, false);
});

const orphanEntry = ({ batchId = 'a-discovery-batch:orphan', createdAt = '2026-09-10T04:00:00.000Z',
  direction = '刚点的方向（合成）', targetStore = 'miska', canAuthorize = true, plan = { provider: 'seerfar', direction } } = {}) =>
  ({ batch: { batchId, revision: 0, targetStore, createdAt, plan }, jobs: [], canAuthorize,
    selections: [], importedCandidates: [], declines: [] });

test('最新一轮排在最前，历史轮次没处理的收进折叠，同一件商品跨轮只出现一次', () => {
  const older = batchEntry({ batchId: 'a-discovery-batch:older', createdAt: '2026-09-08T04:00:00.000Z', direction: '旧方向（合成）',
    products: [product('2107989730'), product('2107989731'), product('2107989732'),
      product('2107989733', { estimate: estimate('excluded_negative', { maximumAllInPurchaseRmb: -1 }) }), product('2107989734')],
    importedCandidates: [{ marketProductId: '2107989732', candidateId: 'candidate:old' }],
    declines: [{ marketProductId: '2107989734', reason: '利润太薄' }] });
  const newer = batchEntry({ batchId: 'a-discovery-batch:newer', createdAt: '2026-09-10T04:00:00.000Z', direction: '新方向（合成）',
    products: [product('2107989735'), product('2107989731')] });
  const feed = feedRows(viewOf(older, newer), 'miska');
  assert.equal(feed.direction, '新方向（合成）');
  assert.equal(feed.current.batchId, 'a-discovery-batch:newer');
  // The newest round comes first in its own sort order; an older round keeps only what the owner already acted on.
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989731', '2107989735', '2107989732']);
  assert.equal(feed.rows[2].importedCandidateId, 'candidate:old');
  // A product returned by both rounds shows once, under the newest round it came back in.
  assert.equal(feed.rows.filter(row => row.marketProductId === '2107989731').length, 1);
  assert.equal(feed.rows[0].batchId, 'a-discovery-batch:newer');
  assert.deepEqual(feed.history.map(row => row.marketProductId), ['2107989730']);
  assert.equal(feed.history[0].batchId, 'a-discovery-batch:older');
  assert.deepEqual(feed.excluded.map(row => row.marketProductId), ['2107989733']);
  assert.deepEqual(feed.declined.map(row => row.marketProductId), ['2107989734']);
  // The two batch buttons act on the newest round, so they count that round only.
  assert.equal(feed.estimable, 2);
  assert.equal(feed.pendingTranslations, 2);
  assert.deepEqual(deskCounts({ discoveryView: viewOf(older, newer), candidates: [], store: 'miska' }), { desk: 3, board: 0, inbox: 0 });
});

test('还没有结果的新批次不抢走本轮标题，待决定仍来自最近一次真的查完的轮次', () => {
  const finished = batchEntry({ batchId: 'a-discovery-batch:finished', createdAt: '2026-09-08T04:00:00.000Z',
    direction: '已经查完（合成）', products: [product('2107989735')] });
  const queued = batchEntry({ batchId: 'a-discovery-batch:queued', createdAt: '2026-09-09T04:00:00.000Z',
    direction: '正在查（合成）', products: [product('2107989736')], jobStatus: 'queued' });
  const feed = feedRows(viewOf(finished, queued, orphanEntry()), 'miska');
  assert.equal(feed.direction, '已经查完（合成）');
  assert.equal(feed.queriedAt, formatInstant('2026-09-08T04:00:00.000Z'));
  assert.equal(feed.current.batchId, 'a-discovery-batch:finished');
  assert.deepEqual(feed.rows.map(row => row.marketProductId), ['2107989735']);
  assert.deepEqual(feed.history, []);
  assert.equal(feed.estimable, 1);
});

test('上一次点了却没开始的那一轮可以直接续上，两种"刚查过"分别说清是不是同一个方向', () => {
  const budget = { maxCredits: 20, estimatedPointsByStep: { quota_before: 0, category_detail: 13, quota_after: 0 } };
  const plan = { planId: 'plan:clothing', version: 'version:1', direction: '宠物服装', budget };
  const previous = { planId: 'plan:bed', version: 'version:1', direction: '宠物躺床', budget };
  const base = { canPrepare: true, plans: [plan], bindings: [{ bindingId: 'binding:x', configurationVersion: 'version:1' }], batches: [] };
  assert.equal(newRoundPlan(base, 'miska').resume, null);
  const resumable = newRoundPlan({ ...base, batches: [orphanEntry({ plan, createdAt: '2026-09-11T09:00:00Z' })] },
    'miska', Date.parse('2026-09-11T10:00:00Z'));
  assert.equal(resumable.ready, true);
  assert.equal(resumable.resume.batchId, 'a-discovery-batch:orphan');
  assert.equal(resumable.resume.expectedRevision, 0);
  assert.equal(resumable.resume.direction, '宠物服装');
  assert.equal(resumable.resume.createdAt, formatInstant('2026-09-11T09:00:00Z'));
  // A saved batch the server says it can no longer authorize is never offered as something to continue.
  assert.equal(newRoundPlan({ ...base, batches: [orphanEntry({ plan, canAuthorize: false })] }, 'miska').resume, null);
  const round = savedPlan => ({ ...base, batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-10T06:15:00Z',
    batchId: 'a-discovery-batch:done', revision: 0, plan: savedPlan },
    jobs: [{ job: { status: 'completed', completedAt: '2026-09-10T06:15:56Z', scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] });
  const same = newRoundPlan(round(plan), 'miska', Date.parse('2026-09-11T00:00:00Z')).warning;
  assert.match(same, /刚查过同一方向「宠物服装」/u);
  assert.match(same, /再查会再扣一次点数/u);
  const different = newRoundPlan(round(previous), 'miska', Date.parse('2026-09-11T00:00:00Z')).warning;
  assert.doesNotMatch(different, /同一方向/u);
  assert.match(different, /刚查过「宠物躺床」/u);
  assert.match(different, /这一轮是「宠物服装」/u);
  assert.match(different, /会再扣一次点数/u);
  assert.equal(newRoundPlan(round(previous), 'miska', Date.parse('2026-09-13T00:00:00Z')).warning, null);
});

// 我选的商品 rows: synthetic candidates that carry the same saved shapes the server returns for a discovered product.
const evidence = (marketProductId = '2107989735', observedMarketPrice = { value: 297, currency: '₽' }) =>
  ({ schemaVersion: 'a-discovery-candidate-evidence-v2', provider: 'seerfar', platform: 'ozon',
    batchId: 'a-discovery-batch:synthetic', marketProductId, observedMarketPrice });
const mine = (id, extra = {}) => candidate(id, { aDiscoveryEvidenceV2: evidence(),
  imageUrl: 'https://ir.ozone.ru/s3/synthetic/2107989735.jpg', ...extra });
const savedDraft = { schemaVersion: 'supplier-draft-v1', sourceUrl: 'https://detail.1688.com/offer/876240928352.html',
  goodsPriceRmb: 15.9, domesticShippingRmb: 2.96, allInPurchaseRmb: 18.86 };
const savedEstimate = (status, profit) => ({ schemaVersion: 'supplier-draft-estimate-v1',
  estimate: { status }, profitAtDeclaredPurchase: profit });
const translated = viewOf(batchEntry({ products: [product('2107989735', { titleZh: '合成收纳盒' })] }));

test('我选的商品把本店选下的商品按最新在前列出，标题、售价和图片只来自已保存记录', () => {
  const rows = myProductRows([
    mine('candidate:older', { createdAt: '2026-09-09T04:00:00.000Z' }),
    mine('candidate:newer', { createdAt: '2026-09-11T04:00:00.000Z' })
  ], translated, 'miska');
  assert.deepEqual(rows.map(row => row.id), ['candidate:newer', 'candidate:older']);
  assert.equal(rows[0].title, '合成收纳盒', '本轮翻译过的中文标题优先');
  assert.equal(rows[0].priceLine, '售价 297 卢布');
  assert.equal(rows[0].imageUrl, 'https://ir.ozone.ru/s3/synthetic/2107989735.jpg');
  // No translation saved for this product: the provider's own title stands, and a blocked image host is dropped.
  const plain = myProductRows([mine('candidate:plain', { imageUrl: 'https://images.example.test/blocked.png' })], viewOf(), 'miska');
  assert.equal(plain[0].title, '合成商品 candidate:plain');
  assert.equal(plain[0].imageUrl, '');
  // A record without a market price never invents one, and a currency the record does not name is never guessed.
  assert.equal(myProductRows([mine('candidate:x', { aDiscoveryEvidenceV2: evidence('2107989735', null) })], viewOf(), 'miska')[0].priceLine, '售价未取得');
  assert.equal(myProductRows([mine('candidate:x', { aDiscoveryEvidenceV2: evidence('2107989735', { value: 297, currency: null }) })], viewOf(), 'miska')[0].priceLine, '售价 297');
  assert.equal(myProductRows([mine('candidate:x', { aDiscoveryEvidenceV2: evidence('2107989735', { value: 12, currency: 'CNY' }) })], viewOf(), 'miska')[0].priceLine, '售价 12 CNY');
});

test('我选的商品的每种下一步都来自这件商品自己保存的找货方案、估算和采集作业', () => {
  // Owner mis-click 2026-09-11: this button only opens the product page, so it must say so; the button that really
  // queues a capture lives on that page and nowhere else.
  const branches = [
    [{}, 'draft_missing', '找货未填', '去填找货'],
    [{ supplierDraftV1: savedDraft }, 'draft_incomplete', '找货已填 · 缺数据', '去补资料'],
    [{ supplierDraftV1: savedDraft, supplierDraftEstimateV1: savedEstimate('incomplete', null) },
      'draft_incomplete', '找货已填 · 缺数据', '去补资料'],
    [{ supplierDraftV1: savedDraft, supplierDraftEstimateV1: savedEstimate('ok', { passes: false, unitProfitRmb: 1.2 }) },
      'draft_blocked', '找货已填 · 未过线', '去改找货'],
    [{ supplierDraftV1: savedDraft, supplierDraftEstimateV1: savedEstimate('ok', { passes: true, unitProfitRmb: 41.26 }) },
      'draft_passes', '找货已填 · 过线 单件利润 ¥41.26', '去申请采集'],
    [{ supplierDraftV1: savedDraft, supplierDraftEstimateV1: savedEstimate('ok', { passes: true, unitProfitRmb: null }) },
      'draft_passes', '找货已填 · 过线 单件利润 未取得', '去申请采集'],
    [{ supplierDraftV1: savedDraft, sourceCapture: { status: 'waiting_extension', jobStatus: 'queued' } }, 'capture_queued', '待采集', '查看'],
    [{ supplierDraftV1: savedDraft, sourceCapture: { status: 'capturing', jobStatus: 'claimed' } }, 'capture_running', '采集中', '查看'],
    [{ supplierDraftV1: savedDraft, sourceCapture: { status: 'captured_waiting_owner_selection' } }, 'capture_done', '已采到', '查看'],
    [{ supplierDraftV1: savedDraft, sourceCapture: { status: 'verified' } }, 'capture_done', '已采到', '查看'],
    // A capture that already stopped is not a step: the owner is sent back to the declaration the estimate judged.
    [{ supplierDraftV1: savedDraft, supplierDraftEstimateV1: savedEstimate('ok', { passes: false, unitProfitRmb: 1.2 }),
      sourceCapture: { status: 'failed', jobStatus: 'failed', failureCode: 'extension_timeout' } }, 'draft_blocked', '找货已填 · 未过线', '去改找货']
  ];
  for (const [saved, step, chip, action] of branches) {
    const [row] = myProductRows([mine('candidate:one', saved)], viewOf(), 'miska');
    assert.deepEqual([row.step, row.chip, row.action], [step, chip, action], JSON.stringify(saved));
  }
});

test('我选的商品只列本店、真的来自查询、还没淘汰的商品，没有就说没有', () => {
  const candidates = [
    mine('candidate:miska'),
    mine('candidate:dandanshu', { targetStore: 'dandanshu' }),
    mine('candidate:gone', { workflowStatus: 'eliminated' }),
    // Older rounds wrote the v1 evidence shape; those products are the owner's too.
    candidate('candidate:legacy', { aDiscoveryEvidenceV1: { schemaVersion: 'a-discovery-candidate-evidence-v1',
      batchId: 'a-discovery-batch:legacy', marketProductId: '2107989740', observedMarketPrice: { value: 500, currency: '₽' } } }),
    // Added by hand, never from a query round.
    candidate('candidate:manual')
  ];
  assert.deepEqual(myProductRows(candidates, viewOf(), 'miska').map(row => row.id), ['candidate:legacy', 'candidate:miska']);
  assert.deepEqual(myProductRows(candidates, viewOf(), 'dandanshu').map(row => row.id), ['candidate:dandanshu']);
  assert.deepEqual(myProductRows(candidates, viewOf(), 'wb'), []);
  assert.deepEqual(myProductRows([], null, 'miska'), []);
  assert.deepEqual(myProductRows(null, null, 'miska'), []);
  assert.equal(myProductRows(candidates, viewOf(), null).length, 3, '不选店铺时三家店的都在，淘汰和手工添加的仍不在');
});

test('"本店已有一轮查询在进行"是一句话，点之前的判断和服务端的拒绝都用它', () => {
  const plan = { planId: 'plan:x', version: 'version:1', direction: '宠物躺床', budget: { maxCredits: 20, estimatedPointsByStep: { category_detail: 13 } } };
  const running = { canPrepare: true, plans: [plan], bindings: [{ bindingId: 'binding:x', configurationVersion: 'version:1' }],
    batches: [{ batch: { targetStore: 'miska', createdAt: '2026-09-11T00:00:00Z', batchId: 'b', revision: 0, plan },
      jobs: [{ job: { status: 'claimed', completedAt: null, scopeBinding: { request: { method: 'category_detail' } } }, receipt: null }] }] };
  assert.equal(newRoundPlan(running, 'miska').reason, ROUND_ALREADY_RUNNING_MESSAGE);
  assert.match(ROUND_ALREADY_RUNNING_MESSAGE, /本店已有一轮查询在进行/u);
  // The server's own refusal reaches the desk as the same sentence, plus where the saved round is continued.
  const refused = deskErrorMessage({ message: '本店已有一轮查询在进行，等它完成后再找；没有新建批次，也没有再扣点数。',
    status: 409, body: { code: 'ROUND_ALREADY_RUNNING' } });
  assert.ok(refused.startsWith(ROUND_ALREADY_RUNNING_MESSAGE));
  assert.match(refused, /用「找一轮新品」继续它/u);
  // Anything else keeps the server's own words.
  assert.equal(deskErrorMessage({ message: '商品资料已变化，请刷新后重新保存找货资料', status: 409, body: { code: 'OTHER' } }),
    '商品资料已变化，请刷新后重新保存找货资料');
});

test('顶栏用的商品名先用翻译过的中文标题，再用原标题，最后用编号，长了就截断', () => {
  assert.equal(shortProductTitle({ productName: 'Explicitly synthetic organizer', id: 'candidate:one' }, '合成收纳盒'), '合成收纳盒');
  assert.equal(shortProductTitle({ productName: '合成收纳盒', id: 'candidate:one' }, null), '合成收纳盒');
  assert.equal(shortProductTitle({ productName: '  ', id: 'candidate:one' }, ''), 'candidate:one');
  assert.equal(shortProductTitle(null, null), '未取得名称');
  assert.equal(shortProductTitle({ productName: '合'.repeat(40) }, null), `${'合'.repeat(16)}…`);
  assert.equal(shortProductTitle({ productName: '合'.repeat(16) }, null), '合'.repeat(16));
});

test('刚建好的那一轮在十分钟内不能另开一轮，选品台在点之前就说清还要等多久', () => {
  const budget = { maxCredits: 20, estimatedPointsByStep: { category_detail: 13 } };
  const plan = { planId: 'plan:clothing', version: 'version:1', direction: '宠物服装', budget };
  const base = { canPrepare: true, plans: [plan], bindings: [{ bindingId: 'binding:x', configurationVersion: 'version:1' }], batches: [] };
  const at = instant => Date.parse(instant);
  const view = { ...base, batches: [orphanEntry({ plan, createdAt: '2026-09-11T09:00:00Z' })] };
  const fresh = newRoundPlan(view, 'miska', at('2026-09-11T09:03:00Z')).resume;
  assert.equal(fresh.canReopenNow, false);
  assert.equal(fresh.reopenWaitMinutes, 7);
  assert.equal(fresh.reopenAt, formatInstant('2026-09-11T09:10:00Z'));
  const later = newRoundPlan(view, 'miska', at('2026-09-11T09:10:00Z')).resume;
  assert.equal(later.canReopenNow, true);
  assert.equal(later.reopenWaitMinutes, 0);
  // The desk's window has to be the server's window, or the sentence it shows would be a guess.
  assert.equal(ROUND_REOPEN_WINDOW_MS, ROUND_RESUMABLE_WINDOW_MS);
});

test('一键淘汰上一轮全部未选只作用于最新一轮里既没要也没不要的那些', () => {
  const newest = batchEntry({ batchId: 'a-discovery-batch:newest', createdAt: '2026-09-11T04:00:00.000Z',
    products: [product('2107989735'), product('2107989736'), product('2107989737'), product('2107989738')],
    importedCandidates: [{ marketProductId: '2107989736', candidateId: 'candidate:taken' }],
    declines: [{ marketProductId: '2107989737', reason: '尺寸太大' }] });
  const older = batchEntry({ batchId: 'a-discovery-batch:older', createdAt: '2026-09-08T04:00:00.000Z',
    products: [product('2107989740')] });
  const feed = feedRows(viewOf(newest, older), 'miska');
  const undecided = lastRoundUndecidedRows(feed);
  assert.deepEqual(undecided.map(row => row.marketProductId), ['2107989735', '2107989738']);
  assert.equal(undecided.every(row => row.batchId === feed.current.batchId), true, '只动最新一轮');
  assert.equal(undecided.every(row => row.expectedRevision === feed.current.expectedRevision), true);
  assert.deepEqual(lastRoundUndecidedRows(feedRows(viewOf(), 'miska')), [], '没有轮次就没有可淘汰的');
  assert.deepEqual(lastRoundUndecidedRows(null), []);
});

test('已淘汰的商品折在每个列表下面，理由和时间照已保存记录原样显示，最新在前', () => {
  const dropped = (id, extra = {}) => candidate(id, { workflowStatus: 'eliminated', ...extra });
  const rows = eliminatedRows([
    dropped('candidate:old', { eliminatedAt: '2026-09-09T04:00:00.000Z', eliminationReason: '主人淘汰：尺寸太大', dataRevision: 7 }),
    dropped('candidate:new', { eliminatedAt: '2026-09-11T04:00:00.000Z', eliminationReason: '主人淘汰', dataRevision: 3 }),
    dropped('candidate:other-store', { targetStore: 'dandanshu', eliminatedAt: '2026-09-11T05:00:00.000Z' }),
    candidate('candidate:alive')
  ], 'miska');
  assert.deepEqual(rows.map(row => row.id), ['candidate:new', 'candidate:old']);
  assert.equal(rows[0].reasonLine, '主人淘汰');
  assert.equal(rows[0].dataRevision, 3);
  assert.equal(rows[1].reasonLine, '主人淘汰：尺寸太大');
  assert.equal(rows[1].eliminatedAtLabel, formatInstant('2026-09-09T04:00:00.000Z'));
  // Nothing is invented for a record that never carried a reason or an instant.
  const bare = eliminatedRows([dropped('candidate:bare')], 'miska');
  assert.equal(bare[0].reasonLine, '没有记录理由');
  assert.equal(bare[0].eliminatedAtLabel, '时间未记录');
  assert.deepEqual(eliminatedRows([dropped('candidate:x')], 'wb'), []);
  assert.equal(eliminatedRows([dropped('candidate:x'), dropped('candidate:y', { targetStore: 'dandanshu' })], null).length, 2);
  assert.deepEqual(eliminatedRows(null, 'miska'), []);
});

test('每条需要你处理的商品都说出为什么等你，说不出就说未取得，绝不编一个理由', () => {
  const reasonsOf = saved => ownerAttentionReasons(candidate('candidate:one', saved));
  const draft = { schemaVersion: 'supplier-draft-v1', sourceUrl: 'https://detail.1688.com/offer/876240928352.html' };
  assert.deepEqual(reasonsOf({}), { reasons: ['找货还没填'], action: { key: 'draft', label: '去填找货' } });
  const incomplete = reasonsOf({ supplierDraftV1: draft,
    supplierDraftEstimateV1: { estimate: { status: 'incomplete', missing: ['官方佣金', '包装尺寸重量'] }, profitAtDeclaredPurchase: null } });
  assert.deepEqual(incomplete.reasons, ['找货已填，还算不出利润：缺官方佣金、包装尺寸重量']);
  assert.deepEqual(incomplete.action, { key: 'draft', label: '去补资料' });
  // A blocked route repeats the saved sentence word for word instead of summarising it.
  const blocked = reasonsOf({ supplierDraftV1: draft,
    supplierDraftEstimateV1: { estimate: { status: 'incomplete', missing: ['可行物流线路'] },
      routeBlock: { message: '当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米。' } } });
  assert.deepEqual(blocked.reasons, ['当前尺寸重量没有可走的国欧线路，需折叠到单边 ≤60 厘米。']);
  const under = reasonsOf({ supplierDraftV1: draft,
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: false, unitProfitRmb: 1.2, marginRate: 0.03 } } });
  assert.deepEqual(under.reasons, ['按你填的到手总价没到本店利润门槛：单件利润 ¥1.20 · 利润率 3%']);
  assert.deepEqual(under.action, { key: 'draft', label: '去改找货' });
  const missingNumbers = reasonsOf({ supplierDraftV1: draft,
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: false, unitProfitRmb: null, marginRate: null } } });
  assert.deepEqual(missingNumbers.reasons, ['按你填的到手总价没到本店利润门槛：单件利润 未取得 · 利润率 未取得']);
  // A capture the owner has to answer wins over everything else, and points at the page that can answer it.
  const sku = reasonsOf({ supplierDraftV1: draft, sourceCapture: { status: 'captured_waiting_owner_selection' },
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: true, unitProfitRmb: 41.26 } } });
  assert.deepEqual(sku.reasons, ['插件已采到1688页面，等你选具体规格']);
  assert.deepEqual(sku.action, { key: 'sku', label: '去选规格' });
  // 选完之后同一条记录不再催同一件事：「需要你处理」说过，处理完一条它会自己消失。
  const chosen = reasonsOf({ supplierDraftV1: draft,
    sourceCapture: { status: 'captured_waiting_owner_selection', selectedSkuIds: ['sku-xl-yellow'] },
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: true, unitProfitRmb: 41.26 } } });
  assert.doesNotMatch(chosen.reasons.join('；'), /等你选具体规格/u);
  const failed = reasonsOf({ supplierDraftV1: draft, sourceCapture: { status: 'failed', failureCode: 'extension_timeout', reason: '插件没有在时限内回报' },
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: true, unitProfitRmb: 41.26 } } });
  assert.deepEqual(failed.reasons, ['上一次采集已停止：插件没有在时限内回报']);
  assert.deepEqual(failed.action, { key: 'capture', label: '重新申请采集' });
  // Nothing blocking of its own: the platform's own asks are the reasons, in the order they were saved.
  const asks = reasonsOf({ supplierDraftV1: draft, needsFromUser: ['确认最终素材', '补一个链接'],
    supplierDraftEstimateV1: { estimate: { status: 'ok' }, profitAtDeclaredPurchase: { passes: true, unitProfitRmb: 41.26 } } });
  assert.deepEqual(asks.reasons, ['确认最终素材', '补一个链接']);
  assert.deepEqual(asks.action, { key: 'capture', label: '去申请采集' });
  assert.deepEqual(ownerAttentionReasons(null), { reasons: ['未取得需要你做什么的记录'], action: { key: 'open', label: '打开' } });
});

test('采到1688页面还没选规格、或采集已停止的商品，即使没有平台缺口也在需要你处理里', () => {
  const waiting = candidate('candidate:sku', { sourceCapture: { status: 'captured_waiting_owner_selection' } });
  const stopped = candidate('candidate:failed', { sourceCapture: { status: 'failed', failureCode: 'extension_timeout' } });
  const running = candidate('candidate:running', { sourceCapture: { status: 'capturing', jobStatus: 'claimed' } });
  // 同一页已经选过规格：这一条就不再等主人，自己从「需要你处理」里消失。
  const chosen = candidate('candidate:chosen', { sourceCapture: { status: 'captured_waiting_owner_selection',
    selectedSkuIds: ['sku-xl-yellow', 'sku-8xl-yellow'] } });
  const items = inboxItems([waiting, stopped, running, chosen, candidate('candidate:quiet')], 'miska');
  assert.deepEqual(new Set(items.map(item => item.id)), new Set(['candidate:sku', 'candidate:failed']));
  assert.equal(items.find(item => item.id === 'candidate:sku').action.key, 'sku');
  assert.equal(items.find(item => item.id === 'candidate:failed').action.key, 'capture');
});

test('做这件之后软件停下来等你的，进「需要你处理」，理由照搬软件停下的原话；软件还在做的不算等你', () => {
  const autopilot = (status, extra = {}) => candidate(`candidate:${status}`, { workflowStatus: 'listing_preparation',
    gate1AutopilotView: { status, line: `${status} 那一句`, stops: [], moreStops: 0, ...extra } });
  const waiting = autopilot('waiting_owner', { stops: [{ code: 'c1_material_gap', line: '还没有保存这件商品的品牌与权利声明，这一步只能你来签' },
    { code: 'c1_material_gap', line: '必填属性「类型」仍需核对' }], moreStops: 1 });
  assert.deepEqual(ownerAttentionReasons(waiting), { reasons: ['还没有保存这件商品的品牌与权利声明，这一步只能你来签', '必填属性「类型」仍需核对', '还有 1 项，打开看'],
    action: { key: 'open', label: '打开' } });
  assert.deepEqual(ownerAttentionReasons(autopilot('failed')).reasons, ['failed 那一句']);
  const items = inboxItems([waiting, autopilot('failed'), autopilot('ready'), autopilot('running'), autopilot('working')], 'miska');
  assert.deepEqual(items.map(item => item.id).sort(), ['candidate:failed', 'candidate:ready', 'candidate:waiting_owner']);
  // 进行中看板上，软件停下来等你的那一句就是卡片下面「等你」那一行；软件还在做的，那一行是空的。
  const cards = boardColumns([waiting, autopilot('running')], 'miska').flatMap(column => column.cards);
  assert.equal(cards.find(card => card.id === 'candidate:waiting_owner').waitingLine, '还没有保存这件商品的品牌与权利声明，这一步只能你来签');
  assert.equal(cards.find(card => card.id === 'candidate:running').waitingLine, null);
});
