import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api} from '../../src/api.js';
import {createPreparationSaveState,createPreparationValues} from '../../src/siblingPreparationState.js';
import SiblingBatchPreparation from '../../src/components/SiblingBatchPreparation.jsx';
import '../../src/styles.css';

function WorkspaceTest(){
 const [preparationSaveState]=useState(createPreparationSaveState);
 const [document,setDocument]=useState(null),[logged,setLogged]=useState(false),[error,setError]=useState('');
 const [shown,setShown]=useState(true),[evidence,setEvidence]=useState(null),[formalAttempts,setFormalAttempts]=useState(0);
 const refresh=async()=>{const result=await api.getState();setDocument(result);
   if(result.runtimeArchitecture?.currentUser?.authenticated)setLogged(true);return result;};
 useEffect(()=>{refresh().catch(e=>setError(e.message));},[]);
 async function login(){try{const access=await api.getOwnerAccess();
   if(access.status==='setup_required')await api.setupOwnerAccess({password:'synthetic password for bounded saved DE HTTP tests'});
   else await api.loginOwnerAccess({password:'synthetic password for bounded saved DE HTTP tests'});
   setLogged(true);await refresh();}catch(e){setError(e.message);}}
 const parent=document?.candidates.find(c=>c.id==='candidate:synthetic-parent');
 const siblings=document?.candidates.filter(c=>c.siblingSourceV1?.parentCandidateId===parent?.id)??[];
 async function controls(action){try{
   const response=await fetch(`/__s1-fixture/${action}`,{method:action==='evidence'?'GET':'POST'});
   if(!response.ok)throw new Error(`S1_FIXTURE_CONTROL_FAILED:${response.status}`);
   setEvidence(await response.json());
 }catch(e){setError(e.message);}}
 async function competingSave(){try{
   const current=await api.getSiblingPreparation(parent.id);
   const values=current.draft?.values??createPreparationValues(current.catalog,parent,siblings,current.supplyPreparation);
   await api.saveSiblingPreparation(parent.id,{parentCandidateId:parent.id,parentRevision:parent.dataRevision,
     memberRevisions:siblings.map(c=>({candidateId:c.id,revision:c.dataRevision})),
     expectedDraftRevision:current.draft?.draftRevision??0,idempotencyKey:`synthetic:competing:${crypto.randomUUID()}`,values});
   await controls('evidence');
 }catch(e){setError(e.message);}}
 function forbidFormal(){setFormalAttempts(count=>count+1);throw new Error('合成验收禁止正式供货、阶段确认和店铺执行');}
 return <main style={{maxWidth:1300,margin:'24px auto',padding:20}}>
   <h1>S1 实际组件 · 隔离合成验收</h1>
   <p>真实 React、API 和 JSON 适配器；只有合成记录，店铺执行绑定为空。</p>
   <button onClick={login}>登录合成主人身份</button>
   <button onClick={()=>refresh().catch(e=>setError(e.message))}>刷新已保存状态</button>
   <button onClick={()=>setShown(value=>!value)}>{shown?'关闭商品页':'重新进入商品页'}</button>
   <button onClick={()=>controls('lost-receipt')}>隔离测试：丢失下一次保存回执</button>
   <button disabled={!logged} onClick={competingSave}>隔离测试：另一页保存同批草稿</button>
   <button onClick={()=>controls('evidence')}>独立读取合成持久结果</button>
   <p id="formal-attempts">正式动作调用次数：{formalAttempts}</p>
   {logged&&parent&&shown?<SiblingBatchPreparation key={parent.id} preparationSaveState={preparationSaveState}
     parent={parent} siblings={siblings} onConfirmA={forbidFormal} onConfirmC1={forbidFormal}
     onConfirmC2={forbidFormal} onAuthorize={forbidFormal}/>:null}
   {error?<p role="alert">{error}</p>:null}
   {evidence?<pre id="saved-evidence">{JSON.stringify(evidence,null,2)}</pre>:null}
 </main>;
}
createRoot(document.getElementById('root')).render(<WorkspaceTest/>);
