import { isDeepStrictEqual } from 'node:util';
import { calculateFreight, validateLifecycleEvidenceData } from './lifecycle-b-input-bundle.mjs';
import { isCanonicalFrozenRef } from './production-contract-primitives.mjs';
import { assertSafeRuntimeRecord } from './runtime-identity.mjs';

export class GuooRouteComparisonError extends Error {
  constructor(code) { super(`GUOO_ROUTE_COMPARISON_${code}`); this.name='GuooRouteComparisonError'; this.code=code; }
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=4096&&!/[\u0000-\u001f\u007f]/u.test(value);
const multiline=value=>typeof value==='string'&&value.trim().length>0&&value.length<=8000;
const positive=value=>Number.isFinite(value)&&value>0;
const nonnegative=value=>Number.isFinite(value)&&value>=0;
const check=(value,code)=>{if(!value)throw new GuooRouteComparisonError(code);};
const closed=(value,fields)=>object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key));
const reason=(code,message)=>({code,message});
const routeFamily=route=>route.replace(/\s+(?:PUDO|Courier)$/u,'');
function routeLabel(route) {
  const match=route.match(/^GUOO (Express|Standard|Economy) (Extra Small|Budget|Small|Big|Premium Small|Premium Big)$/u);
  if(!match)return route;
  return ({Express:'快捷',Standard:'标准',Economy:'经济'})[match[1]]+
    ({'Extra Small':'超级轻小件',Budget:'低客单',Small:'轻小件',Big:'大件','Premium Small':'高货值轻小件','Premium Big':'高货值大件'})[match[2]];
}

function validateInput(input) {
  check(closed(input,['candidateId','sourceRevision','packaging','salePrice','cargoFacts','catalog']), 'INPUT_INVALID');
  check(isCanonicalFrozenRef(input.candidateId)&&Number.isSafeInteger(input.sourceRevision)&&input.sourceRevision>=0,'IDENTITY_INVALID');
  validateInputFacts(input);
  const catalog=input.catalog;
  check(object(catalog)&&catalog.schemaVersion==='guoo-tariff-catalog-v1'&&text(catalog.sourceRef)&&text(catalog.ruleVersion)&&
    typeof catalog.observedAt==='string'&&Number.isFinite(Date.parse(catalog.observedAt))&&Array.isArray(catalog.rows)&&
    catalog.rows.length===15&&Array.isArray(catalog.unresolvedRules),'CATALOG_INVALID');
  const ids=new Set(),routes=new Set();
  for(const row of catalog.rows) {
    check(object(row)&&Number.isSafeInteger(row.rowNumber)&&row.rowNumber>=10&&row.rowNumber<=24&&
      !ids.has(row.rowNumber)&&text(row.route)&&!routes.has(row.route)&&multiline(row.routeText)&&object(row.evidenceData)&&
      Array.isArray(row.deliveryMethods)&&row.deliveryMethods.length>0&&row.deliveryMethods.length<=2&&row.deliveryMethods.every(text)&&
      new Set(row.deliveryMethods).size===row.deliveryMethods.length&&row.deliveryMethods.some(method=>routeFamily(method)===routeFamily(row.route))&&
      object(row.sourceRefs)&&Array.isArray(row.unresolvedRules),'CATALOG_ROW_INVALID');
    ids.add(row.rowNumber);routes.add(row.route);
    const coverage=row.feeCoverage;
    check(closed(coverage,['status','additionalPerParcelRmb','evidenceRef'])&&['complete','unknown'].includes(coverage.status),'FEE_COVERAGE_INVALID');
    check(coverage.status==='complete'?nonnegative(coverage.additionalPerParcelRmb)&&text(coverage.evidenceRef):
      coverage.additionalPerParcelRmb===null&&coverage.evidenceRef===null,'FEE_COVERAGE_INVALID');
  }
  for(const issue of [...catalog.unresolvedRules,...catalog.rows.flatMap(row=>row.unresolvedRules)])
    check(object(issue)&&text(issue.code)&&multiline(issue.message)&&Array.isArray(issue.sourceCells),'CATALOG_ISSUE_INVALID');
  assertSafeRuntimeRecord(input);
}

function validateInputFacts(input) {
  const packaging=input.packaging;
  check(closed(packaging,['weightKg','dimensionsCm','sourceRef'])&&positive(packaging.weightKg)&&text(packaging.sourceRef)&&
    closed(packaging.dimensionsCm,['length','width','height'])&&Object.values(packaging.dimensionsCm).every(positive),'PACKAGING_INVALID');
  if(input.salePrice!==null)check(closed(input.salePrice,['amountRub','sourceRef'])&&positive(input.salePrice.amountRub)&&text(input.salePrice.sourceRef),'SALE_PRICE_INVALID');
  const facts=input.cargoFacts;
  if(facts!==null) {
    check(closed(facts,['batteryType','batteryEnergyWh','generalCargo','personalUse','irregularShape','sourceRef'])&&
      ['none','installed','standalone','unknown'].includes(facts.batteryType)&&
      (facts.batteryEnergyWh===null||positive(facts.batteryEnergyWh))&&
      ['generalCargo','personalUse','irregularShape'].every(key=>facts[key]===null||typeof facts[key]==='boolean')&&text(facts.sourceRef),'CARGO_FACTS_INVALID');
    check(!(facts.generalCargo===true&&['installed','standalone'].includes(facts.batteryType))&&
      !(facts.batteryType==='none'&&facts.batteryEnergyWh!==null),'CARGO_FACTS_CONFLICT');
  }
}

function rangeFromText(value, suffix) {
  if(typeof value!=='string')return null;
  const normalized=value.replace(/\s+/gu,'');
  const match=normalized.match(suffix==='weight'? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)KG(?:收抛)?$/u : /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)₽$/u);
  if(!match)return null;
  const min=Number(match[1]),max=Number(match[2]);
  return positive(min)&&positive(max)&&min<=max?{min,max}:null;
}
function sizeRule(value) {
  if(typeof value!=='string')return null;
  const section=value.match(/尺寸限制[:：]([^]*)$/u);
  if(!section)return null;
  const normalized=section[1].replace(/\s+/gu,'');
  const single=normalized.match(/^三边之和不超(\d+)CM，(?:不算材积，单边最长限制|单边最大尺寸不超)(\d+)CM，按实重，按克计费$/u);
  if(single)return {sum:Number(single[1]),edges:[Number(single[2]),Number(single[2]),Number(single[2])]};
  const edges=normalized.match(/^三边之和不超(\d+)CM，单边最大尺寸不超(\d+)\*(\d+)\*(\d+)CM(?:，按实重，按克计费)?$/u);
  return edges?{sum:Number(edges[1]),edges:edges.slice(2).map(Number).sort((a,b)=>b-a)}:null;
}

function cargoEligibility(ruleText,facts) {
  const unknown=message=>({status:'unknown',reasons:[reason('CARGO_RULE_UNRESOLVED',message)]});
  const excluded=message=>({status:'ineligible',reasons:[reason('CARGO_NOT_ALLOWED',message)]});
  if(facts===null)return unknown('缺少商品运输属性及来源，不能判定该线路适用。');
  const rule=typeof ruleText==='string'?ruleText.replace(/\s+/gu,''):'';
  const express='电池不允许只接普货（不接带电、带磁、液体、粉末、刀具、仿牌等产品）';
  const installed='可以运输内部装有电池的物品无需提供材料安全性数据表MSDS';
  const installedLimited='不可运输纯电池可以运输内部装有电池的物品无需提供材料安全性数据表MSDS最大功率为160瓦特一小时';
  const restricted='异形件:不收，只能走个人用品，不能走商业用品。限运带电类产品，小容量内置电池类（内置电池可以，配套电池禁运）具体看附件表格《限运和敏感寄送限制》';
  if(![express,installed,installedLimited,restricted].includes(rule))return unknown('运输说明不属于已核对的有限文本合同，需核实适用规则。');
  if(facts.batteryType==='unknown')return unknown('电池类型未知，不能推定为普货。');
  if(rule===express) {
    if(facts.batteryType!=='none'||facts.generalCargo===false)return excluded('该线路仅接普货且不允许电池。');
    return facts.generalCargo===true?{status:'eligible',reasons:[]}:unknown('尚未确认商品不含该线路禁止的其他物品。');
  }
  if(rule===restricted) {
    if(facts.irregularShape===true||facts.personalUse===false||facts.batteryType==='standalone')return excluded('该线路不接异形件、商业用品或配套电池。');
    if(facts.irregularShape===null||facts.personalUse===null)return unknown('该线路要求确认非异形件且属于个人用品。');
    if(facts.batteryType==='installed')return unknown('内置电池需对应限运附件，现有文字未明确小容量门槛。');
  }
  if(rule===installedLimited&&facts.batteryType==='standalone')return excluded('该线路明确禁止纯电池。');
  if(facts.batteryType==='standalone')return unknown('该线路现有说明没有确认纯电池的允许范围。');
  if(facts.batteryType==='installed') {
    if(rule===installedLimited) {
      if(facts.batteryEnergyWh===null)return unknown('该线路要求确认电池能量不超过 160 Wh。');
      if(facts.batteryEnergyWh>160)return excluded('电池能量超过该线路文字限制。');
    }
    return unknown('现有电池类型和能量不足以证明完整带电运输条件；仍需该 SKU 的数量、包装及其他禁运项证据。');
  }
  return facts.generalCargo===true?{status:'eligible',reasons:[]}:unknown('尚未确认商品的普通货物属性。');
}

function assessRow(row,input) {
  const tariff=row.evidenceData,reasons=[],uncertain=[],excluded=[];
  const weight=rangeFromText(tariff.weightLimit,'weight'),price=rangeFromText(tariff.declaredValueLimitRub,'price'),size=sizeRule(tariff.sizeLimit);
  if(weight===null)uncertain.push(reason('WEIGHT_LIMIT_UNRESOLVED','重量范围缺失或无法按已知格式解释。'));
  else if(input.packaging.weightKg<weight.min||input.packaging.weightKg>weight.max)excluded.push(reason('WEIGHT_OUTSIDE_LIMIT','实际包装重量不在该线路文字范围内。'));
  if(price===null)uncertain.push(reason('SALE_PRICE_LIMIT_UNRESOLVED','成交价范围缺失或无法按已知格式解释。'));
  if(input.salePrice===null)uncertain.push(reason('SALE_PRICE_REQUIRED','缺少绑定商品的成交价 RUB 及来源。'));
  else if(price!==null&&(input.salePrice.amountRub<price.min||input.salePrice.amountRub>price.max))excluded.push(reason('SALE_PRICE_OUTSIDE_LIMIT','商品成交价不在该线路文字货值范围内。'));
  if(size===null||!positive(size.sum)||!size.edges.every(positive))uncertain.push(reason('SIZE_LIMIT_UNRESOLVED','尺寸限制缺失或不属于已核对的文本格式。'));
  else {
    const edges=Object.values(input.packaging.dimensionsCm).sort((a,b)=>b-a);
    if(edges.reduce((sum,value)=>sum+value,0)>size.sum||edges.some((value,index)=>value>size.edges[index]))excluded.push(reason('SIZE_OUTSIDE_LIMIT','实际包装尺寸超过该线路限制。'));
  }
  const cargo=cargoEligibility(tariff.batteryTransportRule,input.cargoFacts);
  const quoteUncertain=[...uncertain];
  if(cargo.status==='unknown')uncertain.push(...cargo.reasons);
  if(cargo.status==='ineligible')excluded.push(...cargo.reasons);
  // A conflicting source cannot establish exclusion by choosing whichever boundary is convenient.
  const conflicts=row.unresolvedRules.filter(issue=>{
    if(!/CONFLICT/u.test(issue.code))return false;
    if(issue.code==='WEIGHT_LOWER_BOUND_CONFLICT'&&weight!==null) {
      const lower=weight.min===0.501?0.5:weight.min===2.001?2:null;
      return lower===null||input.packaging.weightKg>=lower&&input.packaging.weightKg<weight.min&&
        !excluded.some(item=>item.code!=='WEIGHT_OUTSIDE_LIMIT');
    }
    if(issue.code==='VOLUME_RULE_BOUNDARY_CONFLICT'&&price!==null&&input.salePrice!==null)
      return excluded.length===0&&(input.salePrice.amountRub===price.min||input.salePrice.amountRub===price.max);
    return true;
  });
  const quoteEligibility=conflicts.length?'unknown':excluded.length?'ineligible':quoteUncertain.length?'unknown':'eligible';
  const eligibility=conflicts.length?'unknown':excluded.length?'ineligible':uncertain.length?'unknown':'eligible';
  reasons.push(...excluded,...uncertain,...conflicts.map(issue=>reason(issue.code,issue.message)));
  let baseFreight=null,totalFreightRmb=null;
  if(quoteEligibility!=='ineligible') {
    const validation=validateLifecycleEvidenceData('logistics_tariff',tariff);
    const unresolved=row.unresolvedRules.filter(issue=>!/CONFLICT/u.test(issue.code));
    for(const issue of unresolved)reasons.push(reason(issue.code,issue.message));
    for(const error of validation.errors)reasons.push(reason('FREIGHT_RULE_INCOMPLETE',`${error.path}: ${error.message}`));
    if(!['none','step'].includes(tariff.weightRoundingRule))reasons.push(reason('WEIGHT_ROUNDING_UNRESOLVED','计费进位方式尚未明确。'));
    if(quoteEligibility==='eligible'&&validation.valid&&unresolved.length===0&&['none','step'].includes(tariff.weightRoundingRule)) {
      baseFreight=calculateFreight({id:`${input.catalog.sourceRef}:row-${row.rowNumber}`,scope:{route:routeFamily(row.route),ruleVersion:input.catalog.ruleVersion},evidenceData:tariff},input.packaging);
      check(nonnegative(baseFreight.amountRmb),'CALCULATION_INVALID');
      if(row.feeCoverage.status==='complete') {
        totalFreightRmb=Number((baseFreight.amountRmb+row.feeCoverage.additionalPerParcelRmb).toFixed(2));
        check(nonnegative(totalFreightRmb),'CALCULATION_INVALID');
      }
    }
    if(row.feeCoverage.status!=='complete')reasons.push(reason('COMPLETE_FEE_COVERAGE_REQUIRED','现有表仅证明基础运费，额外适用费用及完整口径尚未确认。'));
  }
  return {rowNumber:row.rowNumber,route:routeFamily(row.route),deliveryMethods:[...row.deliveryMethods],sourceRefs:structuredClone(row.sourceRefs),
    feeCoverage:structuredClone(row.feeCoverage),quoteEligibility,eligibility,reasons,baseFreight,totalFreightRmb};
}

/** Local, single-item comparison only. Does not choose a warehouse, mutate a candidate, or grant execution authority. */
export function compareGuooRoutes(input) {
  validateInput(input);
  const routes=input.catalog.rows.map(row=>assessRow(row,input));
  const globalIssues=input.catalog.unresolvedRules.map(issue=>reason(issue.code,issue.message));
  const blocked=globalIssues.length>0||routes.some(route=>route.quoteEligibility==='unknown'||route.quoteEligibility==='eligible'&&route.totalFreightRmb===null);
  const priced=routes.filter(route=>route.quoteEligibility==='eligible'&&route.totalFreightRmb!==null);
  const status=blocked?'blocked':priced.length?'compared':'no_applicable_routes';
  const minimum=priced.length?Math.min(...priced.map(route=>route.totalFreightRmb)):null;
  const minimumRoutes=status==='compared'?priced.filter(route=>route.totalFreightRmb===minimum)
    .map(({rowNumber,route,totalFreightRmb})=>({rowNumber,route,totalFreightRmb})):[];
  const result={schemaVersion:'guoo-route-comparison-v1',candidateId:input.candidateId,sourceRevision:input.sourceRevision,
    catalogSourceRef:input.catalog.sourceRef,ruleVersion:input.catalog.ruleVersion,
    inputSnapshot:{packaging:structuredClone(input.packaging),salePrice:structuredClone(input.salePrice),cargoFacts:structuredClone(input.cargoFacts)},
    quoteScope:'realfbs_main_table',transportVerified:minimumRoutes.length===1&&routes.find(row=>row.route===minimumRoutes[0].route).eligibility==='eligible',
    selectedRouteLabel:minimumRoutes.length===1?routeLabel(minimumRoutes[0].route):null,
    status,routes,globalIssues,minimumRoutes,selectedRoute:minimumRoutes.length===1?minimumRoutes[0].route:null,platformWrites:0};
  assertSafeRuntimeRecord(result);
  return result;
}


export function assertGuooRouteComparison(result, {candidateId,sourceRevision,catalog} = {}) {
  check(closed(result,['schemaVersion','candidateId','sourceRevision','catalogSourceRef','ruleVersion','inputSnapshot','status','routes',
    'globalIssues','minimumRoutes','selectedRoute','platformWrites','quoteScope','transportVerified','selectedRouteLabel'])&&result.schemaVersion==='guoo-route-comparison-v1'&&
    isCanonicalFrozenRef(result.candidateId)&&Number.isSafeInteger(result.sourceRevision)&&result.sourceRevision>=0&&
    text(result.catalogSourceRef)&&text(result.ruleVersion)&&closed(result.inputSnapshot,['packaging','salePrice','cargoFacts'])&&
    ['blocked','no_applicable_routes','compared'].includes(result.status)&&Array.isArray(result.routes)&&result.routes.length===15&&
    result.quoteScope==='realfbs_main_table'&&typeof result.transportVerified==='boolean'&&Array.isArray(result.globalIssues)&&Array.isArray(result.minimumRoutes)&&result.platformWrites===0,'RESULT_INVALID');
  validateInputFacts(result.inputSnapshot);
  if(candidateId!==undefined)check(result.candidateId===candidateId,'CANDIDATE_CONFLICT');
  if(sourceRevision!==undefined)check(result.sourceRevision===sourceRevision,'REVISION_CONFLICT');
  const rowIds=new Set();
  for(const row of result.routes) {
    check(closed(row,['rowNumber','route','deliveryMethods','sourceRefs','feeCoverage','quoteEligibility','eligibility','reasons','baseFreight','totalFreightRmb'])&&
      Number.isSafeInteger(row.rowNumber)&&row.rowNumber>=10&&row.rowNumber<=24&&!rowIds.has(row.rowNumber)&&text(row.route)&&
      Array.isArray(row.deliveryMethods)&&row.deliveryMethods.length>0&&row.deliveryMethods.length<=2&&row.deliveryMethods.every(text)&&
      object(row.sourceRefs)&&object(row.feeCoverage)&&['eligible','ineligible','unknown'].includes(row.quoteEligibility)&&['eligible','ineligible','unknown'].includes(row.eligibility)&&Array.isArray(row.reasons)&&
      (row.totalFreightRmb===null||nonnegative(row.totalFreightRmb)),'RESULT_ROW_INVALID');
    rowIds.add(row.rowNumber);
    if(row.quoteEligibility!=='eligible')check(row.baseFreight===null&&row.totalFreightRmb===null&&row.reasons.length>0,'RESULT_ROW_INVALID');
    if(row.totalFreightRmb!==null) {
      check(object(row.baseFreight)&&nonnegative(row.baseFreight.amountRmb)&&row.baseFreight.route===row.route&&
        row.baseFreight.evidenceId===`${result.catalogSourceRef}:row-${row.rowNumber}`&&
        row.feeCoverage.status==='complete'&&nonnegative(row.feeCoverage.additionalPerParcelRmb)&&text(row.feeCoverage.evidenceRef)&&
        row.totalFreightRmb===Number((row.baseFreight.amountRmb+row.feeCoverage.additionalPerParcelRmb).toFixed(2)),'RESULT_PRICE_INVALID');
      check(isDeepStrictEqual(row.baseFreight,calculateFreight({id:row.baseFreight.evidenceId,
        scope:{route:row.route,ruleVersion:result.ruleVersion},evidenceData:row.baseFreight.tariff},result.inputSnapshot.packaging)), 'RESULT_PRICE_INVALID');
      const recalculated=assessRow({...row,evidenceData:row.baseFreight.tariff,unresolvedRules:[]},
        {...result.inputSnapshot,catalog:{sourceRef:result.catalogSourceRef,ruleVersion:result.ruleVersion}});
      check(isDeepStrictEqual(row,recalculated),'RESULT_ELIGIBILITY_INVALID');
    }
  }
  for(const issue of [...result.globalIssues,...result.routes.flatMap(row=>row.reasons)])check(closed(issue,['code','message'])&&text(issue.code)&&multiline(issue.message),'RESULT_REASON_INVALID');
  const blocked=result.globalIssues.length>0||result.routes.some(row=>row.quoteEligibility==='unknown'||row.quoteEligibility==='eligible'&&row.totalFreightRmb===null);
  const priced=result.routes.filter(row=>row.quoteEligibility==='eligible'&&row.totalFreightRmb!==null);
  const status=blocked?'blocked':priced.length?'compared':'no_applicable_routes';
  check(result.status===status,'RESULT_STATUS_INVALID');
  const minimum=priced.length?Math.min(...priced.map(row=>row.totalFreightRmb)):null;
  const expectedMinimum=status==='compared'?priced.filter(row=>row.totalFreightRmb===minimum).map(({rowNumber,route,totalFreightRmb})=>({rowNumber,route,totalFreightRmb})):[];
  check(isDeepStrictEqual(result.minimumRoutes,expectedMinimum)&&result.selectedRoute===(expectedMinimum.length===1?expectedMinimum[0].route:null),'RESULT_SELECTION_INVALID');
  check(result.selectedRouteLabel===(expectedMinimum.length===1?routeLabel(expectedMinimum[0].route):null),'RESULT_LABEL_INVALID');
  check(result.transportVerified===(expectedMinimum.length===1&&result.routes.find(row=>row.route===expectedMinimum[0].route).eligibility==='eligible'),'RESULT_TRANSPORT_INVALID');
  if(catalog!==undefined) {
    check(result.catalogSourceRef===catalog.sourceRef&&result.ruleVersion===catalog.ruleVersion,'CATALOG_CONFLICT');
    const expected=compareGuooRoutes({candidateId:result.candidateId,sourceRevision:result.sourceRevision,...result.inputSnapshot,catalog});
    check(isDeepStrictEqual(result,expected),'RESULT_SOURCE_CONFLICT');
  }
  assertSafeRuntimeRecord(result);
  return structuredClone(result);
}

export function appendGuooRouteComparison(candidate, comparison, {recordedAt}) {
  check(object(candidate)&&isCanonicalFrozenRef(candidate.id)&&Number.isSafeInteger(candidate.dataRevision)&&candidate.dataRevision>=0&&
    candidate.dataRevision<Number.MAX_SAFE_INTEGER,'CANDIDATE_INVALID');
  check(typeof recordedAt==='string'&&Number.isFinite(Date.parse(recordedAt)),'RECORDED_AT_INVALID');
  check(candidate.lifecycleV11?.skuPackage===undefined||candidate.lifecycleV11.skuPackage===null,'FROZEN_CANDIDATE');
  if(Object.hasOwn(candidate,'guooRouteComparisonsV1'))check(Array.isArray(candidate.guooRouteComparisonsV1),'HISTORY_INVALID');
  const verified=assertGuooRouteComparison(comparison,{candidateId:candidate.id,sourceRevision:candidate.dataRevision});
  const next=structuredClone(candidate),resultRevision=candidate.dataRevision+1;
  next.guooRouteComparisonsV1=[...(next.guooRouteComparisonsV1??[]),{...verified,recordedAt,resultRevision}];
  next.dataRevision=resultRevision;
  return next;
}


/** Reusing a saved result requires the immediately preceding revision; never search older history for a usable quote. */
function verifySavedGuooComparison(candidate, ruleVersion) {
  check(object(candidate)&&isCanonicalFrozenRef(candidate.id)&&Number.isSafeInteger(candidate.dataRevision)&&candidate.dataRevision>=0,'CANDIDATE_INVALID');
  check(text(ruleVersion),'RULE_VERSION_INVALID');
  check(Object.hasOwn(candidate,'guooRouteComparisonsV1'),'COMPARISON_REQUIRED');
  check(Array.isArray(candidate.guooRouteComparisonsV1),'HISTORY_INVALID');
  check(candidate.guooRouteComparisonsV1.length>0,'COMPARISON_REQUIRED');
  const saved=candidate.guooRouteComparisonsV1.at(-1);
  check(object(saved)&&typeof saved.recordedAt==='string'&&Number.isFinite(Date.parse(saved.recordedAt))&&
    Number.isSafeInteger(saved.resultRevision)&&saved.resultRevision===saved.sourceRevision+1,'SAVED_RESULT_INVALID');
  check(saved.resultRevision===candidate.dataRevision,'SAVED_RESULT_STALE');
  check(saved.ruleVersion===ruleVersion,'RULE_VERSION_CONFLICT');
  const {recordedAt,resultRevision,...comparison}=saved;
  const verified=assertGuooRouteComparison(comparison,{candidateId:candidate.id,sourceRevision:resultRevision-1});
  check(verified.status==='compared'&&verified.minimumRoutes.length===1&&text(verified.selectedRoute),'COMPARISON_NOT_READY');
  check(verified.transportVerified,'TRANSPORT_EVIDENCE_REQUIRED');
  return {...verified,recordedAt,resultRevision};
}

export function assertGuooComparisonReadyForEvidence(candidate, ruleVersion) {
  check(object(candidate)&&isCanonicalFrozenRef(candidate.id)&&Number.isSafeInteger(candidate.dataRevision)&&candidate.dataRevision>=0,'CANDIDATE_INVALID');
  check(text(ruleVersion),'RULE_VERSION_INVALID');
  // 这条路会把线路比较的结果变成这一轮的物流适用范围，所以已经冻结的SKU一律不走：它的线路和运费
  // 早就写进包里了，再比一次等于把主人签过的运费悄悄换掉。重读费用证据不是这件事，见下一个函数。
  check(candidate.lifecycleV11?.skuPackage===undefined||candidate.lifecycleV11.skuPackage===null,'FROZEN_CANDIDATE_REVIEW_REQUIRED');
  return verifySavedGuooComparison(candidate,ruleVersion);
}

const routeKey=value=>String(value??'').trim().toLowerCase();

/**
 * 已冻结的商品重读一次费用证据时，这道闸门代替上面那一道。
 *
 * 上面那道 `FROZEN_CANDIDATE_REVIEW_REQUIRED` 拦的是「别把已冻结商品的线路悄悄重算一遍」。重读佣金和
 * Schema 不做那件事：线路和运费已经冻在 `lifecycleEvidenceContextV11.route` 和 SKU 包里，重读只按那个
 * 已冻结的线路去取同一份资费，`buildExpectedEvidenceScope('logistics_tariff', …)` 读的就是它。所以这里
 * 不放宽那道闸门，而是把它反过来用：**必须**已冻结、**必须**停在条件测算，否则不给走这条路。
 *
 * 光反过来还不够——得当场证明「这件商品冻在哪条线路上」，不能默认。已保存的那份线路比较、已冻结的
 * 运费、以及适用范围里那条线路，三者必须是同一条；对不上就停，绝不拿一份说不清来路的线路去取资费。
 *
 * 比线路名一律先 lower-case：适用范围里留着主人那一版的大小写（`GUOO Economy Extra Small`），冻结运费
 * 和证据包的键已经规范化过（`guoo economy extra small`）。直接比字符串会把同一条线路当成两条——r25 就是
 * 在这上面栽过一次。
 */
export function assertGuooComparisonFrozenForEvidenceRefresh(candidate, ruleVersion) {
  check(object(candidate)&&isCanonicalFrozenRef(candidate.id)&&Number.isSafeInteger(candidate.dataRevision)&&candidate.dataRevision>=0,'CANDIDATE_INVALID');
  check(text(ruleVersion),'RULE_VERSION_INVALID');
  const lifecycle=candidate.lifecycleV11;
  check(object(lifecycle)&&object(lifecycle.skuPackage),'FROZEN_CANDIDATE_REQUIRED');
  check(lifecycle.status==='b_conditional_awaiting_exact_commission','CONDITIONAL_B_REQUIRED');
  const verified=verifySavedGuooComparison(candidate,ruleVersion);
  const frozen=lifecycle.bSystemEvidenceBundle?.logisticsEvidence;
  check(object(frozen)&&routeKey(frozen.route)===routeKey(verified.selectedRoute)&&
    routeKey(frozen.ruleVersion)===routeKey(ruleVersion),'FROZEN_ROUTE_CONFLICT');
  const context=candidate.lifecycleEvidenceContextV11;
  check(object(context)&&routeKey(context.route)===routeKey(verified.selectedRoute)&&
    routeKey(context.logisticsRuleVersion)===routeKey(ruleVersion),'FROZEN_ROUTE_CONFLICT');
  return verified;
}
