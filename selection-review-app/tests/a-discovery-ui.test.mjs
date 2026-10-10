import { createSeerfarDiscoveryRuntimeFixture } from './fixtures/seerfar-discovery-runtime-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import react from '@vitejs/plugin-react';
import {createADiscoveryContractFixture,createADiscoveryContractReceipt} from './fixtures/a-discovery-contract-fixture.mjs';

let renderer;
async function render(props){
  if(!renderer){
    const entry=fileURLToPath(new URL('./a-discovery-ui-entry.jsx',import.meta.url));
    const component=fileURLToPath(new URL('../src/components/ProductDiscoveryCard.jsx',import.meta.url));
    const output=await build({configFile:false,logLevel:'warn',plugins:[react(),{name:'a-discovery-ui-test',
      resolveId:id=>id===entry?entry:null,load:id=>id===entry?`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
      import Card from ${JSON.stringify(component)};export const render=props=>renderToStaticMarkup(<Card {...props}/>);`:null}],
      ssr:{noExternal:true},build:{ssr:true,write:false,rollupOptions:{input:entry,output:{format:'es'}}}});
    const chunk=output.output.find(value=>value.type==='chunk'&&value.isEntry);assert.ok(chunk);
    renderer=await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
  }
  return renderer.render(props);
}
const f=createADiscoveryContractFixture();
const view=()=>({schemaVersion:'a-discovery-view-v1',plans:[f.batch.plan],bindings:[{bindingId:f.batch.bindingId,configurationVersion:f.batch.configurationVersion}],
  canPrepare:true,configurationBlockers:[],targetStores:['miska','dandanshu'],batches:[],hasMore:false,runtimeStatus:'stopped',activeExecution:null,lastAdmissionRejection:null,platformWrites:0});
const forbidden=()=>{throw new Error('RENDER_MUST_NOT_START_WORK');};
const props=v=>({view:v,onCreate:forbidden,onAuthorize:forbidden,onContinue:forbidden,onSelect:forbidden,onTranslate:forbidden,onOpenCandidate:forbidden});

test('discovery UI offers a local preparation and never preselects a paid plan or checkbox',async()=>{
  const html=await render(props(view()));
  assert.match(html,/<option value="" selected="">请选择方向/);
  assert.match(html,/<option value="" selected="">请选择目标店铺/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>准备本轮查询范围/);
  assert.match(html,/只保存本地计划，不查询商品或扣费/);
  assert.doesNotMatch(html,/type="checkbox"/);
});
test('saved batch shows exact plan limits and a separate explicit paid decision',async()=>{
  const v=view();v.batches=[{batch:f.batch,jobs:[],canAuthorize:true,candidateImport:null}];
  const html=await render(props(v));
  assert.match(html,/最多查询 3 次，批准上限 30 LinkFox 积分/);
  assert.match(html,/最多保存 1 件待核验商品/);
  assert.match(html,/详情读取需独立许可/);
  assert.match(html,/失败或空结果是否扣费尚未确认/);
  assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>批准并开始本轮搜索/);
  // The permit expiry is prefilled two hours ahead (owner decision 2026-09-10) but approval still needs the explicit checkbox.
  assert.match(html,/已默认 2 小时后，可改/);
  const expiry=html.match(/type="datetime-local" value="(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})"/);assert.ok(expiry,'prefilled expiry');
  const ahead=Date.parse(expiry[1])-Date.now();assert.ok(ahead>110*60*1000&&ahead<=120*60*1000,`expiry ${ahead}ms ahead`);
});
test('failed and unknown queries expose no replay and imported materials remain unverified',async()=>{
  const v=view(),receipt=createADiscoveryContractReceipt(f);
  v.batches=[{batch:f.batch,canAuthorize:false,jobs:[{job:{...f.job,status:'unknown_outcome'},receipt:null,canContinue:false}],
    candidateImport:{status:'failed',candidateId:null,failureClass:'UNEXPECTED_SYSTEM_ERROR'}}];
  let html=await render(props(v));assert.match(html,/请求结果未知，需核对/);assert.match(html,/保存候选未完成/);
  assert.doesNotMatch(html,/批准并开始本轮搜索|执行已批准且尚未发送的查询|查看待核验商品/);
  v.batches[0]={...v.batches[0],jobs:[{job:{...f.job,status:'completed'},receipt,canContinue:false}],
    candidateImport:{status:'imported',candidateId:'candidate:synthetic'}};
  html=await render(props(v));assert.match(html,/查看待核验商品/);assert.match(html,/Synthetic organizer/);
  assert.doesNotMatch(html,/正式利润通过|供货方案已确认|E验证通过/);
});
test('disabled configuration and all-duplicate history stay explicit',async()=>{
  const v=view();v.plans=[];v.bindings=[];v.runtimeStatus='not_configured';v.canPrepare=false;
  v.configurationBlockers=['PLAN_NOT_CONFIGURED','CONNECTOR_NOT_CONFIGURED','SERVICE_NOT_CONFIGURED'];
  v.batches=[{batch:f.batch,jobs:[],canAuthorize:false,candidateImport:{status:'all_duplicates'}}];
  const html=await render(props(v));assert.match(html,/当前没有可执行计划/);
  assert.match(html,/未重复建卡或恢复已淘汰商品/);assert.doesNotMatch(html,/批准并开始本轮搜索/);
});

test('a connector without its worker explains the engineering gap and cannot prepare a batch',async()=>{
  const v=view();v.canPrepare=false;v.configurationBlockers=['SERVICE_NOT_CONFIGURED'];v.runtimeStatus='not_configured';
  const html=await render(props(v));assert.match(html,/查询执行程序尚未配置/);
  assert.match(html,/不需要你提供商品链接或在聊天中发送密钥/);
  assert.doesNotMatch(html,/准备本轮查询范围|批准并开始本轮搜索|type="password"/);
});

test('unsupported plans explain the capability mismatch without offering a preparation button',async()=>{
  const v=view();v.canPrepare=false;v.plans=[];v.configurationBlockers=['PLAN_NOT_SUPPORTED'];
  const html=await render(props(v));assert.match(html,/已配置服务不能执行计划中的全部查询/);
  assert.doesNotMatch(html,/准备本轮查询范围|批准并开始本轮搜索/);
});


test('Seerfar plan renders its category and three-request points budget without keyword assumptions', async t => {
  const f=await createSeerfarDiscoveryRuntimeFixture(t);
  const {service}=f.create();const created=await f.prepare(service);
  const snapshot=service.view({document:await f.repository.readSnapshot(),actor:f.owner});
  assert.equal(snapshot.batches[0].batch.batchId,created.batch.batchId);
  const html=await render(props(snapshot));
  assert.match(html,/Seerfar 点数/);
  assert.match(html,/类目 100_200/);
  assert.match(html,/三次请求/);
  assert.doesNotMatch(html,/LinkFox 积分/);
  assert.equal(f.calls.length,0);
});

 test('Seerfar material view shows raw review facts and dates but keeps legacy facts unknown', async t => {
  const f = await createSeerfarDiscoveryRuntimeFixture(t);
  const { service } = f.create(); await f.authorize(service, await f.prepare(service));
  const snapshot = service.view({ document: await f.repository.readSnapshot(), actor: f.owner });
  const market = snapshot.batches[0].jobs[0].receipt.steps[1].result;
  Object.assign(market, { dateRange: { startDate: '2026-07-01', endDate: '2026-07-27' } });
  Object.assign(market.products[0], { reviewCount: 142, reviewRating: 4.8, rawSellerType: 1 });
  let html = await render(props(snapshot));
  assert.match(html, /2026-07-01 至 2026-07-27/);
  // The review facts live only in the product stats line now; the old duplicate Seerfar sentence is gone.
  assert.match(html, /评价 142 · 评分 4\.8/); assert.doesNotMatch(html, /服务返回销量（估算）/);
  assert.match(html, /卖家身份未核实/); assert.match(html, /<details><summary>查看来源证据<\/summary><p>服务返回卖家原码：1；未映射为卖家身份/); assert.doesNotMatch(html, /中国跨境|近30天销量|正式利润通过/);
  market.schemaVersion = 'seerfar-discovery-market-result-v1'; delete market.dateRange;
  for (const key of ['reviewCount','reviewRating','rawSellerType']) delete market.products[0][key];
  const bytes = JSON.stringify(snapshot); html = await render(props(snapshot));
  assert.match(html, /评价 未知 · 评分 未知/); assert.match(html, /卖家原码：未知/);
  assert.equal(JSON.stringify(snapshot), bytes); assert.equal(f.calls.length, 3);
});


test('changed saved batch configuration explains why new authorization is unavailable', async () => {
  const v = view();
  v.batches = [{ batch: f.batch, jobs: [], canAuthorize: false, candidateImport: null, configurationBlocker: 'PLAN_NOT_CONFIGURED' }];
  const html = await render(props(v));
  assert.match(html, /该批次的查询配置已变更或移除/);
  assert.match(html, /维护人员需核对当前计划/);
  assert.doesNotMatch(html, /批准并开始本轮搜索/);
});

test('completed results offer one minimal owner pick per product and mark products already in the review board',async()=>{
  const v=view(),receipt=createADiscoveryContractReceipt(f),market=receipt.steps[0].result;
  // The fixture product carries no image and no category, so one imaged product covers the other thumbnail state.
  // Real provider images arrive on the Ozon CDN route, which safeImageUrl passes through to the browser unchanged.
  market.products.push({...market.products[0],productId:'2107989736',productUrl:'https://www.ozon.ru/product/2107989736/',
    title:'Органайзер настольный с фото',imageUrl:'https://ir.ozone.ru/s3/multimedia-1-v/wc300/13913276143.jpg',
    categoryPath:{fullCategoryId:['100_200'],titlePath:'Дом > Хранение',cnTitlePath:'家居 > 收纳',enTitlePath:'Home > Storage'}});
  const ids=market.products.map(product=>product.productId);
  v.batches=[{batch:f.batch,canAuthorize:false,jobs:[{job:{...f.job,status:'completed'},receipt,canContinue:false}],candidateImport:null,selections:[],importedCandidates:[]}];
  let html=await render(props(v)); assert.match(html,/选这个/); assert.doesNotMatch(html,/已在评审台/);
  // The owner must be able to choose without opening anything: expanded list, thumbnail or placeholder, Chinese category, translation slot.
  assert.match(html,/<details open=""><summary>查看本次发现材料<\/summary>/);
  assert.match(html,/<img[^>]*src="https:\/\/ir\.ozone\.ru\/s3\/multimedia-1-v\/wc300\/13913276143\.jpg"[^>]*loading="lazy"/);
  assert.match(html,/无图/);
  assert.match(html,/类目：家居 &gt; 收纳/); assert.match(html,/类目：未知/);
  assert.match(html,/中文标题：待翻译/);
  assert.match(html,/售价 297 卢布 · 销量 未知 · 营收 未知 · 评价 未知 · 评分 未知/);
  v.batches[0].importedCandidates=ids.map((marketProductId,index)=>({marketProductId,candidateId:`candidate:${index}`}));
  html=await render(props(v)); assert.match(html,/已在评审台/); assert.doesNotMatch(html,/选这个/);
  v.batches[0].importedCandidates=[]; v.batches[0].selections=ids.map(marketProductId=>({marketProductId,status:'all_duplicates',candidateId:null,failureClass:null}));
  html=await render(props(v)); assert.match(html,/未重复建卡/); assert.doesNotMatch(html,/选这个/);
  v.batches[0]={...v.batches[0],selections:[],jobs:[{job:{...f.job,status:'failed'},receipt,canContinue:false}]};
  html=await render(props(v)); assert.doesNotMatch(html,/选这个/); assert.doesNotMatch(html,/<details open/);
});

test('completed results offer one translation button for the untranslated titles and show cached Chinese titles',async()=>{
  const v=view(),receipt=createADiscoveryContractReceipt(f);
  v.batches=[{batch:f.batch,canAuthorize:false,jobs:[{job:{...f.job,status:'completed'},receipt,canContinue:false}],candidateImport:null,selections:[],importedCandidates:[]}];
  let html=await render(props(v));
  const total=receipt.steps[0].result.products.length;
  assert.match(html,new RegExp(`翻译标题（${total} 条待翻）`)); assert.match(html,/中文标题：待翻译/);
  receipt.steps[0].result.products[0].titleZh='合成收纳盒';
  html=await render(props(v));
  assert.match(html,/中文标题：合成收纳盒/); assert.match(html,new RegExp(`翻译标题（${total-1} 条待翻）`));
  if(total===1)assert.match(html,/<button[^>]*disabled=""[^>]*>翻译标题/);
});

test('estimated rows show the summary, the flags and no owner pick for a negative ceiling',async()=>{
  const v=view(),receipt=createADiscoveryContractReceipt(f),market=receipt.steps[0].result;
  market.products.push({...market.products[0],productId:'2107989736',productUrl:'https://www.ozon.ru/product/2107989736/',title:'Лежанка для собак'});
  market.products.push({...market.products[0],productId:'2107989737',productUrl:'https://www.ozon.ru/product/2107989737/',title:'Коробка без размеров'});
  const estimate=(outcome,summary,freight,extra={})=>({status:outcome==='selectable'?'ok':outcome==='excluded_negative'?'negative':'incomplete',
    outcome,summary,maximumAllInPurchaseRmb:null,freight,commissionRate:0.14,...extra});
  market.products[0].estimate=estimate('selectable','预估采购上限 ¥120.50 · GUOO Economy Small 0.7kg 运费 ¥37.64（超抛） · 佣金 14%',
    {route:'GUOO Economy Small',chargeableKg:0.7,freightRmb:37.64,oversize:true},{maximumAllInPurchaseRmb:120.5});
  market.products[1].estimate=estimate('excluded_negative','预估负利润，已排除 · GUOO Economy Big 9.5kg 运费 ¥221.89 · 佣金 14%',
    {route:'GUOO Economy Big',chargeableKg:9.5,freightRmb:221.89,oversize:false},{maximumAllInPurchaseRmb:-3.2});
  market.products[2].estimate=estimate('needs_data','无法估算：缺包装尺寸重量 · 佣金 14%',{route:null,chargeableKg:null,freightRmb:null,oversize:false});
  v.batches=[{batch:f.batch,canAuthorize:false,jobs:[{job:{...f.job,status:'completed'},receipt,canContinue:false}],candidateImport:null,selections:[],importedCandidates:[]}];
  let html=await render(props(v));
  assert.match(html,/算利润区间/);
  assert.match(html,/不猜数字/);
  assert.match(html,/预估采购上限 ¥120\.50/); assert.match(html,/超抛/);
  assert.match(html,/无法估算：缺包装尺寸重量/); assert.match(html,/待补尺寸/);
  assert.match(html,/负利润已排除/); assert.match(html,/预估负利润，已排除/);
  // The excluded product offers no owner pick; the other two still do.
  assert.equal(html.match(/选这个/gu).length,2);
  for(const product of market.products)product.estimate=market.products[1].estimate;
  html=await render(props(v));
  assert.equal(html.match(/选这个/gu),null);
  assert.equal(html.match(/预估负利润，已排除/gu).length,6);
});
