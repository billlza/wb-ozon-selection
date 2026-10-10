import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { createPreparationSaveState } from './siblingPreparationState.js';
import { createLatestRead, createSelectionGuard, openSavedCandidate, runMutation, shouldContinuePolling, errorMessage, candidatePlatform } from "./formState.js";
import { validateCandidateCommentReceipt } from "./commentInput.js";
import { c2ReferenceFailureMessage } from "./c2UploadInput.js";
import { IMAGE_MATCH_CHANNEL, OZON_IMAGE_MATCH_CHANNEL, OZON_PAGE_READ_CHANNEL, SEERFAR_WEB_CHANNEL, captureStartMessage, requestSupplierCaptureStart, startQueuedSupplierCapture } from "./captureStart.js";
import { createIntakeJobBridge } from "./intakeJobBridge.js";
import { firstInQueue, matchesQueue } from "./candidateViews";
import CandidateDetail, { CandidateReview } from "./components/CandidateDetail";
import CandidateRail from "./components/CandidateRail";
import DailyProgress from "./components/DailyProgress";
import QueueTabs from "./components/QueueTabs";
import OperatingRules from "./components/OperatingRules";
import ProcessingBreakdown from "./components/ProcessingBreakdown";
import HeaderStatus from "./components/HeaderStatus.jsx";
import LocalOwnerAccessPanel from "./components/LocalOwnerAccessPanel.jsx";
import OzonAccountPreparationCard from './components/OzonAccountPreparationCard.jsx';
import ProductDiscoveryCard from './components/ProductDiscoveryCard.jsx';
import SeerfarWebRoundCard from './components/SeerfarWebRoundCard.jsx';
import ProductDetailPreparationCard from './components/ProductDetailPreparationCard.jsx';
import Phase2ASimulation from "./components/Phase2ASimulation";
const UserInspector = lazy(() => import("./components/UserInspector.jsx"));
import ThreeStoreMap from "./components/ThreeStoreMap";
import SelectionDesk from "./components/SelectionDesk.jsx";
import PipelineBoard from "./components/PipelineBoard.jsx";
import OwnerInbox from "./components/OwnerInbox.jsx";
import IntakePage, { useIntakeQueue } from "./components/IntakePage.jsx";
import { platformOfStore, storeOptions, storesOfPlatform } from "./intakeView.js";
import GlobalNotices from "./components/GlobalNotices.jsx";
const ProductPage = lazy(() => import("./components/ProductPage.jsx"));
import { deskCounts, discoveredTitleZh, shortProductTitle, storeLabel } from "./selectionDeskView.js";
import {
  EXTENSION_STATUS_PING,
  EXTENSION_STATUS_RESPONSE,
  EXTENSION_STATUS_RESPONSE_TIMEOUT_MS,
  extensionConnectionStatus,
  readCachedExtensionVersion
} from "./extensionStatus";

const INITIAL_QUEUE = "codex_processing";
/** 录入页读「找货中」用的那一个读取函数；放在组件外面，引用不变，轮询不会因为重新渲染而重来。 */
const loadIntakeQueue = () => api.getIntakeQueue();
/** The owner's own pages plus the maintenance list; every older page stays reachable under 维护. */
const DESK_VIEWS = ["desk", "seerfar", "board", "inbox", "maint"];
/** Views that read the saved query results, so the read keeps running while the owner is on any of them. */
const DISCOVERY_VIEWS = ["discovery", "seerfar", "product"];
/** Views whose product links open one product page. */
const CANDIDATE_LINK_VIEWS = ["discovery", "desk", "seerfar", "board", "inbox", "product"];
const MAINTENANCE_PAGES = [
  { view: "review", label: "今日选品评审" },
  { view: "discovery", label: "软件找商品" },
  { view: "accounts", label: "账户准备" },
  { view: "map", label: "全店能力地图" },
  { view: "phase2a", label: "第2A模拟验收" }
];
const VIEW_TITLES = { desk: "录入新商品", seerfar: "Seerfar 自动选品", board: "进行中", inbox: "需要你处理", maint: "维护", product: "商品",
  map: "全店能力地图", phase2a: "第2A模拟验收", accounts: "账户准备", discovery: "软件找商品", review: "今日选品评审" };
export default function App() {
  const [preparationSaveState] = useState(createPreparationSaveState);
  const [state, setState] = useState({
    candidates: [],
    meta: null,
    rules: null,
    summary: null,
    seerfarRuntime: null,
    extensionHeartbeat: null,
    runtimeArchitecture: null,
    captureControl: { status: "idle", label: "商品采集控制空闲" }
  });
  const [selectedId, setSelectedId] = useState("");
  const [queue, setQueue] = useState(INITIAL_QUEUE);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [batchExecution, setBatchExecution] = useState(null);
  const [batchExecutionError, setBatchExecutionError] = useState(null);
  const batchReadEpoch = useRef(0);
  const [pollEpoch, setPollEpoch] = useState(0);
  const readFailed = useRef(false);
  const selectionGuard = useRef(createSelectionGuard());
  // The owner lands on 选品台; the older pages keep their behaviour and stay reachable under 维护.
  const [view, setView] = useState("desk");
  const [deskStore, setDeskStore] = useState("miska");
  // 录入页（piece B）：平台 + 店铺名单（GET /api/stores 没上线时用写死的两家 Ozon 店）和找货队列。
  const [stores, setStores] = useState(() => storeOptions(null));
  useEffect(() => {
    const controller = new AbortController();
    api.getStores(controller.signal).then(result => { if (!controller.signal.aborted) setStores(storeOptions(result)); })
      .catch(() => { /* 接口还没上线或读失败：继续用写死的名单 */ });
    return () => controller.abort();
  }, []);
  const [skippedProducts, setSkippedProducts] = useState([]);
  const [threeStoreMap, setThreeStoreMap] = useState(null);
  const [accountPreparationView,setAccountPreparationView]=useState(null);
  const [accountPreparationError,setAccountPreparationError]=useState(null);
  const [accountRefresh,setAccountRefresh]=useState(0);
  const accountReads=useRef(createLatestRead());
  const accountOwner=state.runtimeArchitecture?.currentUser?.authenticated===true&&state.runtimeArchitecture.currentUser.roles.includes('owner');
  const accountOwnerId=accountOwner?state.runtimeArchitecture.currentUser.userId:null;
  // 录入流水线：工作台开着的这一页替录入泵把排好的作业编号递给插件（src/intakeJobBridge.js）；主人登录后才递。
  useEffect(() => {
    if (!accountOwnerId) return undefined;
    const bridge = createIntakeJobBridge({ readQueue: () => api.getIntakeQueue({ bridge: true }),
      onAck: ack => api.reportIntakeStart(ack).catch(() => {}) });
    bridge.start();
    return () => bridge.stop();
  }, [accountOwnerId]);
  const intake = useIntakeQueue({ enabled: view === "desk" && accountOwner, loadQueue: loadIntakeQueue });
  useEffect(() => {
    if (view !== 'product' || !accountOwnerId || !selectedId) return undefined;
    let cancelled = false;
    const epoch = ++batchReadEpoch.current;
    api.getSiblingBatchExecution(selectedId).then(result => {
      if (!cancelled && batchReadEpoch.current === epoch) {
        setBatchExecution({ parentId: selectedId, view: result.executionView });
        setBatchExecutionError(null);
      }
    }).catch(error => { if (!cancelled && batchReadEpoch.current === epoch) setBatchExecutionError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [view, accountOwnerId, selectedId]);
  const accountContext=useRef(null);
  accountContext.current={ownerId:accountOwnerId,view,store:deskStore};
  useEffect(()=>{selectionGuard.current.changed();},[accountOwnerId,view,deskStore]);
  useEffect(()=>{
    setAccountPreparationView(null);setAccountPreparationError(null);
    if(view!=='accounts'||!accountOwner)return undefined;
    const controller=new AbortController();
    accountReads.current.run(api.getAccountPreparations,setAccountPreparationView,{signal:controller.signal})
      .catch(error=>{if(!controller.signal.aborted)setAccountPreparationError(error.message);});
    return ()=>{controller.abort();accountReads.current.cancel();};
  },[view,accountOwnerId,accountRefresh]);
  async function runAccountPreparation(action,payload) {
    const ownerId=accountOwnerId;
    return accountReads.current.run(()=>action(payload),result=>{
      if(accountContext.current.ownerId===ownerId&&accountContext.current.view==='accounts')setAccountPreparationView(result);
    },{protect:true});
  }
  const [discoveryView,setDiscoveryView]=useState(null);
  const [discoveryError,setDiscoveryError]=useState(null);
  const [discoveryRefresh,setDiscoveryRefresh]=useState(0);
  const discoveryReads=useRef(createLatestRead());
  useEffect(()=>{
    setDiscoveryView(null);setDiscoveryError(null);
    if(!DISCOVERY_VIEWS.includes(view)||!accountOwner)return undefined;
    const controller=new AbortController();let timer;
    async function read(){
      try{
        const next=await discoveryReads.current.run(api.getProductDiscovery,setDiscoveryView,{signal:controller.signal});
        if(!controller.signal.aborted&&next?.batches.some(entry=>entry.jobs.some(({job})=>['queued','claimed','waiting_platform'].includes(job.status)))) {
          timer=window.setTimeout(read,3000);
        }
      }catch(error){if(!controller.signal.aborted)setDiscoveryError(error.message);}
    }
    read();
    return ()=>{controller.abort();window.clearTimeout(timer);discoveryReads.current.cancel();};
  },[view,accountOwnerId,discoveryRefresh]);
  /** Seerfar 榜单（方案 B）：「Seerfar 榜单」页里选品台下方的面板。一轮在等插件或等主人搜索时每 3 秒回读一次，收完就停。 */
  const [seerfarView,setSeerfarView]=useState(null);
  const [seerfarError,setSeerfarError]=useState(null);
  const [seerfarRefresh,setSeerfarRefresh]=useState(0);
  useEffect(()=>{
    setSeerfarError(null);
    if(view!=='seerfar'||!accountOwner)return undefined;
    const controller=new AbortController();let timer;
    async function read(){
      try{
        const next=await api.getSeerfarSelection(controller.signal);
        if(controller.signal.aborted)return;
        setSeerfarView(next);
        if(next.rounds.some(round=>['waiting_extension','capturing'].includes(round.status))||
          Object.values(next.storeSales||{}).some(store=>store.running))timer=window.setTimeout(read,3000);
      }catch(error){if(!controller.signal.aborted)setSeerfarError(error.message);}
    }
    read();
    return ()=>{controller.abort();window.clearTimeout(timer);};
  },[view,accountOwnerId,seerfarRefresh]);
  async function startSeerfarRound(payload){
    const result=await api.startSeerfarRound(payload);
    setSeerfarView(result);
    const jobId=result.operationResult?.captureJob?.jobId;
    const ack=jobId?await requestSupplierCaptureStart(jobId,window,SEERFAR_WEB_CHANNEL):null;
    setSeerfarRefresh(value=>value+1);
    return {type:ack?.accepted?'success':'error',text:captureStartMessage(ack,SEERFAR_WEB_CHANNEL)};
  }
  async function readStoreSales(targetStore){
    const result=await api.readStoreSales({targetStore});
    setSeerfarView(result);
    setSeerfarRefresh(value=>value+1);
    return {type:'success',text:'开始读了：两次销量请求之间要隔一分钟，读完这里会自己更新。'};
  }
  /**
   * Every discovery write goes through here and never through the read guard: the guard drops its result whenever a
   * refresh or a view switch happens mid-flight, which is how a confirmed round reached the server and was reported to
   * the owner as "没有创建成功" (2026-09-11). The server's answer is always returned; only publishing it is conditional.
   */
  async function mutateProductDiscovery(action,payload){
    const ownerId=accountOwnerId;
    const current=()=>accountContext.current.ownerId===ownerId&&DISCOVERY_VIEWS.includes(accountContext.current.view);
    return runMutation(()=>action(payload),{reads:discoveryReads.current,isCurrent:current,publish(next){
      setDiscoveryView(next);setDiscoveryRefresh(value=>value+1);
    }});
  }
  /**
   * The 找货 step of one product. Opening it derives the market snapshot from the already-saved query receipt and
   * recomputes the estimate on the server; the page itself starts no work and reads no platform.
   */
  const [productDraftView,setProductDraftView]=useState(null);
  const [productDraftError,setProductDraftError]=useState(null);
  const [productDraftRefresh,setProductDraftRefresh]=useState(0);
  const productDraftReads=useRef(createLatestRead());
  /**
   * The step data follows the saved record. When the poll sees a newer revision for the product on screen — the
   * capture the owner was waiting for just came back with its specifications — the step is read again, instead of
   * leaving the page saying it has nothing to show while the server already holds the answer.
   */
  const productRevision=view==='product'
    ? state.candidates.find(item=>item.id===selectedId)?.dataRevision??null
    : null;
  // Switching products clears the previous product's draft; a refresh of the same product keeps what is on screen.
  useEffect(()=>{setProductDraftView(null);},[selectedId]);
  useEffect(()=>{
    setProductDraftError(null);
    if(view!=='product'||!accountOwner||!selectedId)return undefined;
    const controller=new AbortController();
    productDraftReads.current.run(signal=>api.getSupplierDraft(selectedId,signal),setProductDraftView,{signal:controller.signal})
      .catch(error=>{if(!controller.signal.aborted)setProductDraftError(errorMessage(error));});
    return ()=>{controller.abort();productDraftReads.current.cancel();};
  },[view,accountOwnerId,selectedId,productDraftRefresh,productRevision]);
  async function runProductStep(action,payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const result=await productDraftReads.current.run(()=>action(candidateId,payload),next=>{
      if(accountContext.current.ownerId===ownerId&&accountContext.current.view==='product'&&next?.supplierDraftV1!==undefined){
        setProductDraftView(next);
      }
    },{protect:true});
    await load(true);
    setProductDraftRefresh(value=>value+1);
    return result;
  }
  /**
   * 申请插件采集 on the product page. Two things separate it from runProductStep: the write never passes through the
   * read guard (a cancelled read would hide the server's real answer — the same class of error r13 fixed), and the
   * queued receipt is followed by the page→content-script start signal. The extension background only keeps a
   * heartbeat and never polls for jobs, so without that signal the job can only sit until it expires, which is exactly
   * what the owner saw four times on 2026-09-11. The returned sentence is what the page shows in its own notice slot.
   */
  async function requestProductCapture(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.confirmRealAStage(candidateId,payload),{
        reads:productDraftReads.current,isCurrent:current,
        publish(next){if(next?.supplierDraftV1!==undefined)setProductDraftView(next);}
      });
      const start=await startQueuedSupplierCapture(result);
      if(start)return start.message;
      return result?.status==="supplier_capture_job_queued"
        ? "这件商品已经有一个还在等待的采集作业，这次没有重新创建；等它结束后再申请，软件不会自动重试"
        : "已提交A阶段确认，这次没有创建采集作业；请看上面的采集状态";
    // Whatever happened — accepted, refused by the extension, or refused by the server — the page then shows the state
    // the server actually holds, so a rejection is never read off a stale card.
    }finally{await load(true);setProductDraftRefresh(value=>value+1);}
  }
  /**
   * 这次采集没有结果，我确认并重新申请. Two explicit steps, in this order and never merged: the review route records the
   * owner's own acknowledgement that no result arrived (it writes no capture evidence and moves no business state), and
   * only then does the existing request chain run again. The second step must carry the revision the review actually
   * produced — the review advances dataRevision, so the payload built from the page's candidate is already stale. If
   * either step fails the owner is told which one, because "已核实但没能重新申请" and "根本没核实" need different actions.
   */
  async function reviewCaptureAndRequest({review,capture}){
    const candidateId=selectedId;
    let reviewed;
    try{reviewed=await api.reviewSourceCapture(candidateId,review);}
    catch(cause){await load(true);setProductDraftRefresh(value=>value+1);throw new Error(`没能记下你的确认，这次也没有重新申请采集：${errorMessage(cause)}`);}
    try{return await requestProductCapture({...capture,dataRevision:reviewed.candidate.dataRevision,sourceDataRevision:reviewed.candidate.dataRevision});}
    catch(cause){throw new Error(`已记下你的确认（这条记录不再挡路），但这次重新申请采集没有成功：${errorMessage(cause)}`);}
  }
  /**
   * 重新采集 — read the same 1688 page again. It is the same two moves as 申请插件采集, for the same reasons: the write
   * stays out of the read guard so the server's real answer cannot be cancelled into null, and the queued receipt is
   * followed by the one start signal in captureStart.js, because the extension background never polls for jobs. Only
   * the request differs: this one goes to the recapture route, which is the single place that re-queues a capture whose
   * specifications are already waiting on the owner.
   */
  async function recaptureProductSource(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.recaptureSourceCapture(candidateId,payload),{
        reads:productDraftReads.current,isCurrent:current,
        publish(next){if(next?.supplierDraftV1!==undefined)setProductDraftView(next);}
      });
      const start=await startQueuedSupplierCapture(result);
      if(start)return start.message;
      return "这件商品已经有一次采集还在等插件，这次没有重新开始；等它结束后再试，软件不会自动重试";
    }finally{await load(true);setProductDraftRefresh(value=>value+1);}
  }
  /**
   * 读一次这个 Ozon 商品页 —— 算利润卡在类目上时唯一的出路。
   *
   * 和 申请插件采集 / 重新采集 是同样的两步，理由也一样：写操作留在读取守卫之外（被取消的读会把服务端真正的回答
   * 抹成 null），拿到排队回执之后必须发一条开始信号，因为插件后台只维持心跳、从不主动轮询作业。只有目标不同，
   * 所以走的是 captureStart.js 里同一个 helper，只把消息类型换成 Ozon 那一条，没有第二份实现。
   */
  async function readOzonProductPage(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.startOzonSalesCapture(candidateId,payload),{
        reads:productDraftReads.current,isCurrent:current,
        publish(next){if(next?.supplierDraftV1!==undefined)setProductDraftView(next);}
      });
      const start=await startQueuedSupplierCapture(result,{channel:OZON_PAGE_READ_CHANNEL});
      if(start)return start.message;
      return "这件商品已经有一次读页面还在等插件，这次没有重新开始；等它结束后再试，软件不会自动重试";
    }finally{await load(true);setProductDraftRefresh(value=>value+1);}
  }
  /**
   * 用首图（拼多多、1688 货源首图或 Ozon 主图）在 1688 找同款。和读 Ozon 页面是同样的两步：写操作留在读取守卫之外，拿到排队回执之后发那一条开始信号
   * （插件后台从不主动轮询作业），只是消息类型换成找同款那一条。比对首图和主人的判断是普通的写，完了按服务端实际保存的
   * 状态重读一次。
   */
  async function startSupplierImageMatch(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.startSupplierImageMatch(candidateId,payload),{reads:productDraftReads.current,isCurrent:current});
      const start=await startQueuedSupplierCapture(result,{channel:IMAGE_MATCH_CHANNEL});
      if(start)return start.message;
      return "这件商品已经有一次找同款还在等插件，这次没有重新开始；等它结束后再试，软件不会自动重试";
    }finally{await load(true);}
  }
  /** 在 Ozon 找同款：和上面同样的两步，只是带上这次搜的词、换成 Ozon 找同款那一条开始信号。 */
  async function startOzonImageMatch(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      const result=await runMutation(()=>api.startOzonImageMatch(candidateId,payload),{reads:productDraftReads.current,isCurrent:current});
      const start=await startQueuedSupplierCapture(result,{channel:OZON_IMAGE_MATCH_CHANNEL});
      if(start)return start.message;
      return "这件商品已经有一次在 Ozon 找同款还在等插件，这次没有重新开始；等它结束后再试，软件不会自动重试";
    }finally{await load(true);}
  }
  async function writeSupplierImageMatch(action,payload){
    const candidateId=selectedId;
    try{await action(candidateId,payload);}
    finally{await load(true);}
  }
  /**
   * 算利润 的确认。它走的是既有的 A 阶段确认那条路（成功后服务端自己接着算 B），所以这里只做三件事：把写操作放在读取
   * 守卫之外——被取消的读会把服务端真正的回答抹成 null，那正是 r13 修掉的那一类错误——把服务端的回执原样交回页面，让
   * 页面照它实际保存成什么样说话，然后无论成败都按服务端实际保存的状态重读一次。服务端拒绝时把它自己那句话原样抛回
   * 页面，不改写、不概括。
   */
  async function confirmProductProfitStep(payload){
    const ownerId=accountOwnerId,candidateId=selectedId;
    const current=()=>accountContext.current.ownerId===ownerId&&accountContext.current.view==='product';
    try{
      return await runMutation(()=>api.confirmRealAStage(candidateId,payload),{
        reads:productDraftReads.current,isCurrent:current,
        publish(next){if(next?.supplierDraftV1!==undefined)setProductDraftView(next);}
      });
    }finally{await load(true);setProductDraftRefresh(value=>value+1);}
  }
  const [extensionStatus, setExtensionStatus] = useState(() => extensionConnectionStatus({
    cachedVersion: readCachedExtensionVersion()
  }));
  const effectiveExtensionStatus = useMemo(() => {
    // The page bridge answered for this exact tab, so its verdict wins; only an unanswered ping falls back to the heartbeat.
    if (["connected", "background_unavailable", "reload_required"].includes(extensionStatus.code)) {
      return extensionStatus;
    }
    return extensionConnectionStatus({
      cachedVersion: readCachedExtensionVersion(),
      serverHeartbeat: state.extensionHeartbeat
    });
  }, [extensionStatus, state.extensionHeartbeat]);

  useEffect(() => {
    let responseTimer;
    let liveVersion = "";
    let pendingNonce = "";
    function ping() {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingNonce = nonce;
      window.postMessage({ type: EXTENSION_STATUS_PING, nonce }, window.location.origin);
      window.clearTimeout(responseTimer);
      responseTimer = window.setTimeout(() => {
        liveVersion = "";
        setExtensionStatus(extensionConnectionStatus({ cachedVersion: readCachedExtensionVersion() }));
      }, EXTENSION_STATUS_RESPONSE_TIMEOUT_MS);
    }
    function onMessage(event) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== EXTENSION_STATUS_RESPONSE) return;
      if (event.data?.nonce !== pendingNonce) return;
      liveVersion = String(event.data.version || "").trim();
      window.clearTimeout(responseTimer);
      setExtensionStatus(extensionConnectionStatus({
        liveVersion,
        backgroundReady: event.data.backgroundReady === true
      }));
    }
    window.addEventListener("message", onMessage);
    ping();
    const interval = window.setInterval(ping, 10000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(interval);
      window.clearTimeout(responseTimer);
    };
  }, []);

  const latestRead = useRef(createLatestRead());
  const ownerPermissionsKnown = useRef(false);
  const currentView = useRef({ queue, sourceFilter });
  currentView.current = { queue, sourceFilter };

  const load = useCallback(async (quiet = false, { protect = false, joinProtected = false, confirmOwnerPermissions = false, signal } = {}) => {
    try {
      const next = await latestRead.current.run(api.getState, (value) => {
        readFailed.current = false;
        if (confirmOwnerPermissions) ownerPermissionsKnown.current = true;
        setState((current) => ({ ...value, seerfarRuntime: current.seerfarRuntime,
          runtimeArchitecture: value.runtimeArchitecture && !ownerPermissionsKnown.current
            ? { ...value.runtimeArchitecture, currentUser: null } : value.runtimeArchitecture }));
      }, { protect, joinProtected, signal });
      if (!next || signal?.aborted) return null;
      const { queue, sourceFilter } = currentView.current;
      setSelectedId((currentId) => {
        const current = next.candidates.find((candidate) => candidate.id === currentId);
        if (current && matchesQueue(current, queue, sourceFilter)) return currentId;
        return firstInQueue(next.candidates, queue, sourceFilter)?.id || "";
      });
      if (!quiet) setLoading(false);
      return next;
    } catch (error) {
      if (signal?.aborted) return null;
      readFailed.current = true;
      // 「刷新数据」已经收进「维护」，所以这句话必须说清楚现在去哪儿点它。
      setNotice({ type: "error", message: `读取共享数据失败，轮询已暂停；到「维护」里点“刷新数据”恢复：${error.message}` });
      if (!quiet) setLoading(false);
      return null;
    }
  }, []);

  const clearOwnerPermissions = useCallback(() => {
    selectionGuard.current.changed();
    ownerPermissionsKnown.current = false;
    latestRead.current.cancel();
    setState(current => ({ ...current, runtimeArchitecture: current.runtimeArchitecture ? { ...current.runtimeArchitecture, currentUser: null } : null }));
  }, []);
  const refreshOwnerPermissions = useCallback(async (access, { signal } = {}) => {
    clearOwnerPermissions();
    const next = await load(true, { protect: true, confirmOwnerPermissions: true, signal });
    if (!next && !signal?.aborted) throw new Error("主人登录状态已读取，但当前业务权限回读失败；请重新读取登录状态。");
  }, [clearOwnerPermissions, load]);

  useEffect(() => () => latestRead.current.cancel(), []);
  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();
    async function poll() {
      if (!shouldContinuePolling({ active, failed: readFailed.current })) return;
      await load(true, { signal: controller.signal });
      if (!active) return;
      setLoading(false);
      if (shouldContinuePolling({ active, failed: readFailed.current })) timer = window.setTimeout(poll, 3000);
    }
    poll();
    return () => { active = false; window.clearTimeout(timer); controller.abort(); };
  }, [load, pollEpoch]);

  useEffect(() => {
    if (!notice || notice.type === "error") return undefined;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selected = useMemo(
    () => state.candidates.find((candidate) => candidate.id === selectedId) || null,
    [state.candidates, selectedId]
  );
  const [productDetailView,setProductDetailView]=useState(null);
  const [productDetailError,setProductDetailError]=useState(null);
  const [productDetailRefresh,setProductDetailRefresh]=useState(0);
  const productDetailReads=useRef(createLatestRead());
  const detailCandidateId=selected?.aDiscoveryEvidenceV1?selected.id:null;
  const detailRevision=selected?.dataRevision;
  const detailContext=useRef(null);
  detailContext.current={candidateId:detailCandidateId,revision:detailRevision,ownerId:accountOwnerId,view};
  useEffect(()=>{
    setProductDetailView(null);setProductDetailError(null);
    if(view!=='review'||!accountOwnerId||!detailCandidateId)return undefined;
    const controller=new AbortController();let timer;
    async function read() {
      try {
        const next=await productDetailReads.current.run(signal=>api.getProductDetails(detailCandidateId,detailRevision,signal),setProductDetailView,{signal:controller.signal});
        if(!controller.signal.aborted&&next?.jobs.some(({job})=>['queued','claimed','waiting_platform'].includes(job.status)))timer=window.setTimeout(read,3000);
      }catch(error){
        if(controller.signal.aborted)return;
        if(error.status===409&&error.body?.code==='CANDIDATE_CHANGED') {
          await load(true,{signal:controller.signal});
        }else setProductDetailError(error.message);
      }
    }
    read();
    return ()=>{controller.abort();window.clearTimeout(timer);productDetailReads.current.cancel();};
  },[view,accountOwnerId,detailCandidateId,detailRevision,productDetailRefresh,load]);
  async function runProductDetails(action,payload) {
    if(!selected||selected.id!==payload.candidateId||selected.dataRevision!==payload.expectedRevision)throw new Error('商品或版本已变化，请重新读取详情准备。');
    const context=detailContext.current;
    try {
      const result=await productDetailReads.current.run(()=>action(payload),next=>{
        if(detailContext.current.candidateId===context.candidateId&&detailContext.current.revision===context.revision&&
          detailContext.current.ownerId===context.ownerId&&detailContext.current.view===context.view)setProductDetailView(next);
      },{protect:true});
      await load(true);
      return result;
    }finally{
      if(detailContext.current.candidateId===context.candidateId&&detailContext.current.ownerId===context.ownerId)setProductDetailRefresh(value=>value+1);
    }
  }

  const loadThreeStoreMap = useCallback(async () => {
    try {
      const next = await api.getThreeStoreMap();
      setThreeStoreMap(next);
      return next;
    } catch (error) {
      setNotice({ type: "error", message: `读取全店能力地图失败：${error.message}` });
      return null;
    }
  }, []);

  useEffect(() => {
    if (view === "map") loadThreeStoreMap();
  }, [view, loadThreeStoreMap]);

  function openQueue(nextQueue, preferredId = "", nextSourceFilter = sourceFilter) {
    selectionGuard.current.changed();
    if (["eliminated", "listed"].includes(nextQueue)) nextSourceFilter = "all";
    currentView.current = { queue: nextQueue, sourceFilter: nextSourceFilter };
    setQueue(nextQueue);
    setSourceFilter(nextSourceFilter);
    const preferred = state.candidates.find(
      (candidate) =>
        candidate.id === preferredId && matchesQueue(candidate, nextQueue, nextSourceFilter)
    );
    setSelectedId(
      preferred?.id || firstInQueue(state.candidates, nextQueue, nextSourceFilter)?.id || ""
    );
  }

  function navigateResult(candidate, token) {
    if (!selectionGuard.current.isCurrent(token)) return;
    currentView.current = { queue: candidate.workflowStatus, sourceFilter: "all" };
    setQueue(candidate.workflowStatus);
    setSourceFilter("all");
    setSelectedId(candidate.id);
  }
  async function openDiscoveredCandidate(candidateId){
    if(!CANDIDATE_LINK_VIEWS.includes(accountContext.current.view))return;
    return openSavedCandidate({candidateId,selectionGuard:selectionGuard.current,
      readState:options=>load(true,options),getContext:()=>accountContext.current,
      onMissing(){
        setDiscoveryError('候选未能从当前保存记录回读，请刷新核对。');
        setNotice({type:'error',message:'这件商品没能从当前保存记录里读出来，请刷新数据后再打开。'});
      },
      onOpen(candidate){
        setDiscoveryError(null);setNotice(null);
        currentView.current={queue:candidate.workflowStatus,sourceFilter:'all'};
        // All product links use the saved record; the old A card stays under 维护.
        setQueue(candidate.workflowStatus);setSourceFilter('all');setSelectedId(candidate.id);setView('product');
      }
    });
  }
  /**
   * 淘汰 / 恢复 from any list. The write carries the revision the list rendered, so a stale page is refused with 409
   * instead of dropping something the owner is no longer looking at; either way the page then reads what was saved.
   */
  async function eliminateCandidate({ id, dataRevision, reason }){
    const revision=Number.isInteger(dataRevision)?dataRevision:state.candidates.find(item=>item.id===id)?.dataRevision;
    try{
      await api.eliminateCandidate(id,{dataRevision:revision,...(typeof reason==='string'&&reason!==''?{reason}:{})});
      setNotice({type:'success',message:'已淘汰，可以在列表底部的「已淘汰」里恢复。'});
    }catch(error){
      setNotice({type:'error',message:errorMessage(error)});
      throw error;
    }finally{await load(true);}
  }
  async function restoreCandidate({ id, dataRevision }){
    const revision=Number.isInteger(dataRevision)?dataRevision:state.candidates.find(item=>item.id===id)?.dataRevision;
    try{
      await api.restoreCandidate(id,{dataRevision:revision});
      setNotice({type:'success',message:'已恢复，它回到了淘汰前的那一步；没有自动继续任何事。'});
    }catch(error){
      setNotice({type:'error',message:errorMessage(error)});
      throw error;
    }finally{await load(true);}
  }
  /** 贴货源链接 (piece D): one request to the intake pipeline, then the shared state is read again. */
  async function submitSourceLink(payload){
    try{return await api.submitIntakeLinks(payload.links,["miska","dandanshu"].includes(deskStore)?deskStore:null);}
    finally{await load(true);}
  }



  async function createSiblingSkuBatch(payload) {
    const parentCandidateId = selectedId;
    const result = await api.createSiblingSkuBatch(parentCandidateId, payload);
    await load(true);
    setNotice({ type: 'success', message: `已建立 ${result.createdCount} 个规格的内部 A 记录；正式利润、颜色、图片和生产授权仍待核验。` });
    return result;
  }

  async function confirmSiblingBatchA(payload) {
    const result = await api.confirmSiblingBatchA(payload.parentCandidateId, payload);
    await load(true);
    setNotice({ type: 'success', message: `整批 ${result.members.length} 个规格已各自完成 A、正式 B 利润和 C1 输入交接；C1 事实、素材和生产授权仍待核验。` });
    return result;
  }

  async function readSiblingBatchColorDictionary(child) {
    const candidateId = child.id;
    const skuPackageId = child.lifecycleV11.skuPackage.skuPackageId;
    try {
      const authorized = await api.authorizeC1ColorDictionary(candidateId, {
        candidateId, skuPackageId, attributeId: '10096', dataRevision: child.dataRevision });
      const read = await api.continueC1ColorDictionary(candidateId, {
        candidateId, skuPackageId, attributeId: '10096', authorizationId: authorized.result.authorizationId,
        dataRevision: authorized.candidate.dataRevision });
      await load(true);
      setNotice({ type: read.result?.status === 'succeeded' ? 'success' : 'error',
        message: read.result?.status === 'succeeded' ? '本批官方颜色候选已保存，请逐行核对。' : '官方颜色读取结果未确定，请先核对原请求。' });
      return read;
    } catch (error) { await load(true); throw error; }
  }

  async function confirmSiblingBatchC1(payload) {
    const result = await api.confirmSiblingBatchC1(payload.parentCandidateId, payload);
    await load(true);
    setNotice({ type: 'success', message: `整批 ${result.members.length} 个规格的独立 C1 事实和共享草稿已确认，正在等待最终素材。` });
    return result;
  }

  async function previewSiblingBatchC1(payload) {
    return api.previewSiblingBatchC1(payload.parentCandidateId, payload);
  }

  async function authorizeSiblingProductionBatch(payload) {
    const result = await api.authorizeProductionBatch(payload);
    batchReadEpoch.current += 1;
    setBatchExecution({ parentId: selectedId, view: result.executionView });
    setBatchExecutionError(null);
    await load(true);
    setNotice({ type: 'success', message: `整批 ${result.batch.members.length} 个规格的生产授权已原子保存；请查看逐项导入、库存与 E 回读结果。` });
    return result;
  }

  async function saveSiblingBatchStockDrafts(payload) {
    const result = await api.saveSiblingBatchCommercialDrafts(payload);
    await load(true);
    setNotice({ type: 'success', message: `本批 ${result.members.length} 个规格的库存草稿已一起保存；请核对新版本再确认生产。` });
    return result;
  }

  async function refreshSiblingBatchExecution(batchId) {
    const view = await api.getProductionBatch(batchId);
    batchReadEpoch.current += 1;
    setBatchExecution({ parentId: selectedId, view });
    setBatchExecutionError(null);
    return view;
  }

  async function resumeSiblingBatchStock(batchId) {
    const result = await api.resumeProductionBatchStock(batchId);
    batchReadEpoch.current += 1;
    setBatchExecution({ parentId: selectedId, view: result.executionView });
    setBatchExecutionError(null);
    return result;
  }

  async function uploadSiblingC2Asset(candidateId, context) {
    try {
      const result = await api.uploadLifecycleFinalAsset(candidateId, context);
      await load(true);
      return result;
    } catch (error) { await load(true); throw error; }
  }

  async function linkSiblingC2Asset(candidateId, payload) {
    try {
      const result = await api.linkSiblingC2Asset(candidateId, payload);
      await load(true);
      return result;
    } catch (error) { await load(true); throw error; }
  }

  async function confirmSiblingBatchC2(payload) {
    const result = await api.confirmSiblingBatchC2(payload.parentCandidateId, payload);
    await load(true);
    setNotice({ type: 'success', message: '整批最终素材和独立确认卡已保存；尚未取得生产授权。' });
    return result;
  }

  async function updateSelected(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.updateCandidate(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({ type: "success", message: result.dispatch ? "资料已保存，并已进入受控异常处理" : "资料已保存；软件状态机未唤醒Codex，停止状态也没有被自动重启" });
      await load(true);
    } catch (error) {
      if (error.body?.duplicateId) {
        const nextState = await load(true);
        const duplicate = nextState?.candidates.find((candidate) => candidate.id === error.body.duplicateId);
        if (duplicate) navigateResult(duplicate, navigationToken);
        setNotice({ type: "warning", message: `${error.message}，已跳转已有候选` });
      } else {
        setNotice({ type: "error", message: errorMessage(error) });
        if (error.status === 409) await load(true);
        throw error;
      }
    }
  }

  async function confirmRealAStage(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.confirmRealAStage(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      // Same receipt, same start signal as before; only the sentence now comes from the shared ACK-code mapping.
      const captureStart = await startQueuedSupplierCapture(result);
      navigateResult(result.candidate, navigationToken);
      setNotice({
        type: "success",
        message: payload.decision === "reject"
          ? "A阶段已淘汰当前商品；未启动B或任何平台操作"
          : result.status === "supplier_capture_job_queued"
            ? captureStart
              ? `A阶段供应链接已保存；${captureStart.message}`
              : "A阶段供应链接已保存；这件商品已经有一个还在等待的采集作业，这次没有重新创建，系统不会自动重试"
          : result.candidate.lifecycleV11?.skuPackage?.businessPhase === "C1"
            ? "A确认已原子保存，B已自动通过并创建C1；无需再次点击开始上架准备"
            : "A确认已原子保存，B已自动计算；当前商品未进入C1"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 422 && error.body?.guooRouteComparison?.candidateId === selected.id) await load(true);
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function chooseRecoveryAction(action) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const result = await api.chooseRecoveryAction(selected.id, {
        dataRevision: selected.dataRevision,
        action
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已按固定处理方式交给${result.dispatch.assigneeTitle || "当前负责人"}；再次真实失败仍会停止`
          : "已记录为保持停止，系统不会自动重试"
      });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function evaluateSelected(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const previousId = selected.id;
      const result = await api.saveUserEvaluation(previousId, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      setNotice({
        type: "success",
        message:
          payload.decision === "reject"
            ? "已淘汰；不会自动补充新候选"
            : "该旧判断入口已停止执行；新版商品请使用A阶段完整确认卡"
      });
      const nextState = await load(true);
      if (selectionGuard.current.isCurrent(navigationToken)) {
        const current = currentView.current;
        const next = firstInQueue(nextState?.candidates || [], "awaiting_user_direction", current.sourceFilter, previousId);
        if (current.queue === "awaiting_user_direction" && next) setSelectedId(next.id);
        else navigateResult(result.candidate, navigationToken);
      }
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function commentSelected(input) {
    const { candidateId, ...request } = input || {};
    if (!selected || selected.id !== candidateId) {
      throw new Error("当前候选已变化；留言内容仍保留，请刷新后重新提交。");
    }
    try {
      const result = validateCandidateCommentReceipt(input, await api.addComment(candidateId, request));
      setNotice({
        type: "success",
        message:
          request.category === "elimination_feedback"
            ? "淘汰原因已保存，后续自动选品会读取这条避坑条件"
            : "留言已保存；普通留言不会启动或重试任务"
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function markSelectedListed(payload) {
    const navigationToken = selectionGuard.current.capture();
    if (!selected) return;
    try {
      const platform = candidatePlatform(selected);
      if (payload.platform !== platform || payload.store !== selected.targetStore) throw new Error("平台与当前目标店铺不一致，未保存。");
      const result = await api.markListed(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision
      });
      navigateResult(result.candidate, navigationToken);
      setNotice({ type: "success", message: "已移入“已上架”，复盘记录和上架信息均已保留" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function startSourceCapture(recoverySuggestion = "", mode = "") {
    if (!selected) return null;
    if (mode !== "listed_evidence_recovery" || selected.workflowStatus !== "listed") throw new Error("旧C阶段供应采集入口已退役；不得从C1/C2重新访问供应平台。");
    try {
      const result = await api.startSourceCapture(selected.id, {
        dataRevision: selected.dataRevision,
        recoverySuggestion,
        ...(mode ? { mode } : {})
      });
      setNotice({ type: "success", message: "已创建当前已上架商品的单次证据回补请求，等待后台认证领取；页面不接收或转发作业凭据。尚未证明采集已开始。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function startOzonSalesCapture(productUrl = null) {
    if (!selected) return null;
    try {
      // 不给地址 = 读这件商品自己的页面（原样）。给了 = 主人指名读一个对标页面，
      // 它会以 comparable 标记存进 salesSnapshotsV11，供最终定价多样本比较和关键词素材使用。
      const result = await api.startOzonSalesCapture(selected.id, {
        dataRevision: selected.dataRevision,
        ...(typeof productUrl === "string" && productUrl.trim() ? { productUrl: productUrl.trim() } : {})
      });
      // The same receipt → start signal as every other capture: the extension background only keeps a heartbeat and
      // never polls, so a queued job with no signal can do nothing but expire (owner, four attempts, 2026-09-11).
      const captureStart = await startQueuedSupplierCapture(result, { channel: OZON_PAGE_READ_CHANNEL });
      setNotice({ type: "success", message: captureStart
        ? captureStart.message
        : "这件商品已经有一次读页面还在等插件，这次没有重新开始；页面不转发凭据，也不把请求接受当作采集完成。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function selectSourceCaptureSku(sourceSkuIds, context) {
    if (!selected) return null;
    try {
      const result = await api.selectSourceCaptureSku(selected.id, {
        dataRevision: context.dataRevision,
        sourceSkuIds
      });
      setNotice({
        type: "success",
        message: result.dispatch
          ? `已确认${sourceSkuIds.length}个1688 SKU，并且只向选品任务派发当前商品B阶段一次`
          : `已确认${sourceSkuIds.length}个1688 SKU；证据已保存，原上架记录保持不变且没有自动派发任务`
      });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function recalculateBWithExactCommission(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未复算旧商品。");
    try {
      const result = await api.recalculateBWithExactCommission(selected.id, payload);
      // 这一次用的是店里的实收费率还是官方费率表，必须跟着结果说出来。两种都算正式B，
      // 可只有实收费率能上架；不说清楚，主人会以为这件商品已经可以提交生产授权了。
      const official = result.result.commissionEvidenceMode === "official_reference";
      const usedLine = official
        ? "这一次用的是 Ozon 官方费率表上的公开费率，不是这个店被扣过的钱；上架之前仍然要读到店里的实收费率。"
        : "这一次用的是店里同类目在售商品的实收费率。";
      setNotice({ type: "success", message: (result.result.status === "passed"
        ? "正式利润已通过，上架准备已接收该商品；供货确认保持不变。"
        : "正式利润未达到门槛，结果已保存；未进入上架准备。") + usedLine });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  /**
   * 重读一次费用证据。这一步只换证据，利润结论一个字都不动——那句话要说出来，
   * 不然主人会以为按完这一下就完事了，而真正改结论的是紧接着那一次「用更好的费用证据重算」。
   */
  async function refreshBFeeEvidence(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未替旧商品读取费用证据。");
    try {
      const result = await api.refreshBFeeEvidence(selected.id, payload);
      const kinds = { commission: "佣金", schema: "Schema", exchange_rate: "汇率", logistics_tariff: "物流资费" };
      const read = (result.evidencePacks || []).map(pack => kinds[pack.kind] || pack.kind);
      setNotice({ type: "success", message: read.length === 0
        ? "已经核对过：这件商品的费用证据都是当期的，没有需要重读的，什么都没有改动。"
        : `已经重新读到${read.join("、")}证据并存下来；规格、货价、线路、运费和供货确认都没有动，也没有向 Ozon 写任何东西。` +
          "利润结论还是原来那份条件测算——要用新证据换掉它，请再点一次「用更好的费用证据重算」。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function continueC1Preparation(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未继续准备。");
    try {
      const result = await api.continueC1Preparation(selected.id, payload);
      setNotice({ type: "success", message: payload.mode === "saved_material_only"
        ? "本节点准备结果已保存，请在商品页核查属性、关键词和剩余缺项。"
        : "已继续准备文案素材；只用了本机已冻结的资料，没有查询关键词、没有付费调用。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  // 同一次1688采集里已采到、却没搬进冻结快照的供应商属性。免费，不碰价格与身份。
  async function backfillC1SupplyAttributes(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未补齐供应属性。");
    try {
      const result = await api.backfillC1SupplyAttributes(selected.id, payload);
      const added = result?.result?.addedAttributeKeys ?? [];
      setNotice({ type: "success", message: added.length
        ? `已把同一次采集里的 ${added.length} 条页面属性补进冻结快照：${added.join("、")}。没有外部调用、没有付费。`
        : "页面属性已经都在冻结快照里了，没有改动任何数据。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  // 重读类目 Schema，把计划里冻结的那一份换成新的。只读、免费，不碰价格与事实。
  async function refreshC1CategorySchema(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未重读类目资料。");
    try {
      const result = await api.refreshC1CategorySchema(selected.id, payload);
      const change = result?.change;
      const added = change?.requiredFieldsAdded ?? [];
      const removed = change?.requiredFieldsRemoved ?? [];
      const diff = added.length || removed.length
        ? `；平台必填字段有变：新增 ${added.join("、") || "无"}，移除 ${removed.join("、") || "无"}`
        : "";
      setNotice({ type: "success", message:
        `已重读Ozon类目资料：${change?.attributeCount ?? 0} 个属性，其中 ${change?.dictionaryBackedCount ?? 0} 个带字典${diff}。没有付费调用、没有改价格。` });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  // 让软件把属性表填好。模型只在字典真实候选里挑，主人只做判断。
  async function proposeC1OzonAttributes(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未生成建议。");
    try {
      const result = await api.proposeC1OzonAttributes(selected.id, payload);
      const p = result?.proposal;
      setNotice({ type: "success", message:
        `已生成 ${p?.suggestedCount ?? 0} 条建议（另有 ${p?.alternativeOnlyCount ?? 0} 行只有对标备选）；俄文值全部来自 Ozon 字典，没有写入任何数据。` });
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      throw error;
    }
  }

  // 主人签下「这条中文事实，在Ozon上就是这个俄文字典值」。软件拿Ozon自己的字典核对。
  async function saveC1OzonAttributeMapping(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未保存属性映射。");
    try {
      const result = await api.saveC1OzonAttributeMapping(selected.id, payload);
      const count = result?.result?.mappedAttributeIds?.length ?? 0;
      setNotice({ type: "success", message: `已保存 ${count} 条Ozon属性映射；字典项逐字核对，自由文本项按当前类目资料保存，没有付费调用。` });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function reviseSiblingColor(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error('当前商品已变化，未建立颜色修订。');
    try {
      const result = await api.reviseSiblingColor(selected.id, payload);
      setNotice({ type: 'success', message: '已建立新的 C1 修订；请核对本规格的颜色映射及权利声明。旧版保留历史。' });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function readC1ColorDictionary(candidateId, { attributeId, authorizationId = null }) {
    if (!selected || candidateId !== selected.id) throw new Error('当前商品已变化，未读取颜色字典。');
    try {
      const skuPackageId = selected.lifecycleV11.skuPackage.skuPackageId;
      const authorized = authorizationId ? null : await api.authorizeC1ColorDictionary(candidateId, {
        candidateId, skuPackageId, attributeId, dataRevision: selected.dataRevision
      });
      const read = await api.continueC1ColorDictionary(candidateId, { candidateId, skuPackageId, attributeId,
        authorizationId: authorizationId ?? authorized.result.authorizationId,
        dataRevision: authorized?.candidate?.dataRevision ?? selected.dataRevision });
      setNotice({ type: read.result?.status === 'succeeded' ? 'success' : 'error',
        message: read.result?.status === 'succeeded'
          ? '已保存当前类目的完整官方颜色候选，请核对后选择。'
          : '颜色字典结果不完整或未知，当前候选不可用于映射；请核对已保存状态。' });
      await load(true);
      return read;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function retryC1KeywordHandoff(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧交接。");
    try {
      const result = await api.retryC1KeywordHandoff(selected.id, payload);
      setNotice({ type: "success", message: "文案请求已准备，等待这一次付费许可；没有重复查询关键词。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function authorizeC1PaidDraft(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未提交旧许可。");
    try {
      const result = await api.authorizeC1PaidDraft(selected.id, payload);
      setNotice({ type: "success", message: "已取得本次许可和执行状态，请查看文案回执。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function readOriginalC1DraftResult(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未读取旧任务。");
    try {
      const result = await api.readOriginalC1DraftResult(selected.id, payload);
      const messages = {
        applied: "本次文案结果已取回并保存，请核对商品内容。",
        idempotent_replay: "本次文案结果已保存，请核对商品内容。",
        pending: "原任务仍在处理或正在核对。本次没有重新生成；稍后可再次读取结果。",
        unknown_outcome: "本次仍未取得确定结果，没有重新生成。请查看任务提示。",
        failed: "原任务返回失败或结果未通过核验，没有重新生成。请查看失败记录。"
      };
      const message = messages[result.executionStatus];
      if (!message) throw new Error("本次结果读取返回了无法识别的状态，请核对保存记录。");
      setNotice({ type: ["applied", "idempotent_replay"].includes(result.executionStatus) ? "success"
        : result.executionStatus === "pending" ? "info" : "error", message });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function continueSavedC1Draft(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧任务。");
    try {
      const result = await api.continueSavedC1Draft(selected.id, payload);
      setNotice({ type: "success", message: "已取得原任务的执行状态，请查看文案回执。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function confirmC1EditorialContent(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未确认旧修订文案。");
    try {
      const result = await api.confirmC1EditorialContent(selected.id, payload);
      setNotice({ type: "success", message: "修订文案已确认，可以准备本规格的图片。原文案和用量记录已保留。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function confirmC1Content(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未确认旧文案。");
    try {
      const result = await api.confirmC1Content(selected.id, payload);
      setNotice({ type: "success", message: "商品内容已确认，请上传本规格的图片并安排主图和顺序。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function saveC1RightsReview(payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error("当前商品已变化，未提交旧声明。");
    try {
      const result = await api.saveC1RightsReview(selected.id, payload);
      setNotice({ type: "success", message: "本件商品的品牌与权利声明已保存，后续执行按当前证据判断。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  async function saveProductionOwnerDecision(payload) {
    if (!selected) return;
    try {
      const result = await api.saveProductionOwnerDecision(selected.id, payload);
      setNotice({ type: "success", message: "生产授权和任务已保存，请查看当前执行结果。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function reviseC1FinalPlan(payload) {
    if (!selected || selected.id !== payload.candidateId || selected.dataRevision !== payload.dataRevision ||
        selected.lifecycleV11?.skuPackage?.skuPackageId !== payload.skuPackageId) {
      throw new Error("当前商品资料已变化，请核对新版后再准备方案。");
    }
    try {
      const result = await api.reviseC1FinalPlan(selected.id, payload);
      setNotice({ type: "success", message: "已用现有资料准备新版本；新文案尚未生成，未收费、未上架。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function saveFinalPricingReview(payload) {
    if (!selected || selected.id !== payload.candidateId) throw new Error("当前商品已变化，未提交旧定价复核。");
    try {
      const result = await api.saveFinalPricingReview(selected.id, payload);
      setNotice({ type: "success", message: result.pricingStatus === "price_unchanged"
        ? "最终市场比较已保存，价格仍引用有效的原利润版本。"
        : result.pricingStatus === "profit_rejected" ? "新价格的利润未通过，原资料已保留，未创建生产授权。"
          : "最终定价复核已保存，请查看新利润版本与后续资料状态。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function continueSavedDE(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未继续旧任务。");
    try {
      const result = await api.continueSavedDE(candidateId, payload);
      setNotice({ type: "success", message: "已取得原任务的执行状态，请查看生产与平台核验结果。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function dispatchDProductionRound(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未重派生产作业。");
    try {
      const result = await api.dispatchDProductionRound(candidateId, payload);
      setNotice({ type: "success", message: "已在同一份生产授权下排好新一轮作业；还没有发送任何平台请求，请点「继续已保存任务」开始执行。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function rollbackProductionAuthorization(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未作废任何授权。");
    try {
      const result = await api.rollbackProductionAuthorization(candidateId, payload);
      setNotice({ type: "success", message: "本轮生产授权已作废并整体归档留底，商品退回到等你确认那一刻；价格、库存、图片和文案都没动，平台上也没有写入任何东西。下一步：重签最终商品确认卡，再通过进入生产授权。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function reobserveDUnknownOutcome(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未重新观察。");
    try {
      const result = await api.reobserveDUnknownOutcome(candidateId, payload);
      setNotice({ type: "success", message: "已按新规则重新排了一次只读查询，没有往平台写任何东西。稍等片刻页面会更新：如果平台报的只是警告，就会继续往下走；如果确实有真错误，会把每条错误的级别和文案显示出来，那时再告诉施工方处理。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function reconcileDFromPlatformState(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未收口。");
    try {
      const result = await api.reconcileDFromPlatformState(candidateId, payload);
      setNotice({ type: "success", message: "已排了两次只读查询（商品现状和仓库库存），没有往平台写任何东西。稍等片刻页面会更新：库存正好等于你授权的数，这一轮就登记成「库存由你填写」并收口；对不上会停下，并说明停在哪一步。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function recoverDInitialImport(candidateId, payload) {
    if (!selected || candidateId !== selected.id) throw new Error("当前商品已变化，未登记任何导入。");
    try {
      const result = await api.recoverDInitialImport(candidateId, payload);
      setNotice({ type: "success", message: "这次导入已经对账登记回来了，软件只做了只读查询，没有往平台写任何东西。接下来软件会自动按期限查询商品状态和仓库库存；库存如果已经是你自己填的数，软件只登记「这是你填的」，不会覆盖。" });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function runAccountRead(action, payload) {
    if (!selected || payload.candidateId !== selected.id) throw new Error('当前商品已变化，未提交旧的账户核验。');
    try {
      const result = await action(payload);
      setNotice({ type: 'success', message: '本次账户核验状态已保存，请查看取得的资料及剩余缺口。' });
      await load(true);
      return result;
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error) });
      await load(true);
      throw error;
    }
  }

  async function uploadLifecycleFinalAsset(file, context) {
    if (!selected) throw new Error("当前没有选中的商品");
    try {
      return await api.uploadLifecycleFinalAsset(selected.id, {
        dataRevision: context?.dataRevision ?? selected.dataRevision,
        draftRevision: context.draftRevision,
        file
      });
    } catch (error) {
      setNotice({ type: "error", message: errorMessage(error) });
      // A rejected file can already have a persisted failed registration and a new draft revision.
      await load(true);
      throw error;
    }
  }

  async function saveC2UploadDraft(payload) {
    if (!selected) throw new Error("当前没有选中的商品");
    return api.saveC2UploadDraft(selected.id, payload);
  }

  async function confirmLifecycleFinalAssets(payload) {
    if (!selected) return;
    try {
      await api.confirmLifecycleFinalAssets(selected.id, {
        ...payload,
        dataRevision: payload.dataRevision ?? selected.dataRevision,
        confirmed: true
      });
      setNotice({ type: "success", message: "最终素材及顺序已锁定，最终商品方案卡已生成；尚未生产授权，也没有店铺写入" });
      await load(true);
    } catch (error) {
      setNotice({ type: "error", message: c2ReferenceFailureMessage(error.message) || errorMessage(error) });
      if (error.status === 409) await load(true);
      throw error;
    }
  }

  function changeQueue(nextQueue) {
    openQueue(nextQueue);
  }

  function changeSourceFilter(nextFilter) {
    selectionGuard.current.changed();
    currentView.current = { queue, sourceFilter: nextFilter };
    setSourceFilter(nextFilter);
    setSelectedId(firstInQueue(state.candidates, queue, nextFilter)?.id || "");
  }

  if (loading) {
    return <div className="app-loading">正在打开全店经营工作台…</div>;
  }

  const counts = deskCounts({ discoveryView, candidates: state.candidates, store: deskStore });
  // The product page is read twice: once by the top bar, which names it and keeps the way back, once by the page itself.
  const productCandidate = view === "product" ? state.candidates.find(item => item.id === selectedId) ?? null : null;
  const productTitleZh = view === "product" ? discoveredTitleZh(discoveryView, productCandidate) : null;
  const siblingCandidates = productCandidate === null ? [] : state.candidates
    .filter(item => item.siblingSourceV1?.parentCandidateId === productCandidate.id);
  const siblingSkuIds = siblingCandidates.map(item => item.siblingSourceV1.supplierSkuId);
  const deskPlatform = platformOfStore(stores, deskStore);
  const deskStoreLine = `${stores.platforms.find(item => item.value === deskPlatform)?.label ?? ""} · ${
    stores.stores.find(item => item.storeKey === deskStore)?.label ?? storeLabel(deskStore)}`;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <h1>选品台</h1>
          {view === "product"
            ? <p className="app-brand-product">商品 · {shortProductTitle(productCandidate, productTitleZh)}
              <button type="button" className="app-brand-back" onClick={() => setView("desk")}>← 选品台</button></p>
            : view === "desk" ? <p>{VIEW_TITLES.desk}</p>
            : <p className="app-brand-product">{VIEW_TITLES[view] ?? "今日选品评审"}
              <button type="button" className="app-brand-back" onClick={() => setView("desk")}>← 录入新商品</button></p>}
        </div>
        {/* 顶栏只剩：平台和店铺、需要你处理、一个状态指示器。进行中和维护在录入页底部。 */}
        <div className="desk-store-switch" role="group" aria-label="平台和店铺">
          <label>平台
            <select value={deskPlatform ?? ""} aria-label="选择平台"
              onChange={event => setDeskStore(storesOfPlatform(stores, event.target.value)[0]?.storeKey ?? deskStore)}>
              {stores.platforms.map(platform => <option key={platform.value} value={platform.value}>{platform.label}</option>)}
            </select>
          </label>
          <label>店铺
            <select value={deskStore} onChange={event => setDeskStore(event.target.value)} aria-label="选择店铺">
              {storesOfPlatform(stores, deskPlatform).map(store => <option key={store.storeKey} value={store.storeKey}>{store.label}</option>)}
            </select>
          </label>
        </div>
        <div className="header-actions">
          <button type="button" className={`button ${view === "inbox" ? "secondary" : "primary"} header-inbox`} onClick={() => setView("inbox")}>
            需要你处理<span className="desk-badge">{counts.inbox}</span>
          </button>
          {/* 三条工程状态收成一条：都正常时一个圆点，任何一条不正常才占主人的注意力。 */}
          <HeaderStatus extensionStatus={effectiveExtensionStatus} captureControl={state.captureControl}
            runtimeArchitecture={state.runtimeArchitecture} intakeQueue={intake.queue} />
        </div>
      </header>
      {/* 已登录是常态，不必每一页都声明；没登录、读不出来或只是预览身份时这一条必须仍然显眼。退出登录收在「维护」里。 */}
      <LocalOwnerAccessPanel showAuthenticated={view === "maint"}
        onAccessResolved={refreshOwnerPermissions} onAccessUnknown={clearOwnerPermissions} />
      {notice ? <div role={notice.type === "error" ? "alert" : "status"} className={`global-notice ${notice.type}`}>{notice.message}</div> : null}

      {/* Piece D: page-wide notices and the runs that did not happen, read from saved records; nothing reruns by itself. */}
      {DESK_VIEWS.includes(view) && accountOwner ? <GlobalNotices extensionStatus={effectiveExtensionStatus}
        candidates={state.candidates} discoveryView={discoveryView} store={deskStore} loadIntakeQueue={loadIntakeQueue}
        intakeShownOnPage={view === "desk"}
        onRetryIntake={async ({ candidateId, dataRevision }) => { try { return await api.retryIntake(candidateId, dataRevision); } finally { await load(true); } }}
        onResumeIntake={async () => { try { return await api.resumeIntake(); } finally { await load(true); } }}
        onStartRound={payload => mutateProductDiscovery(api.startProductDiscovery, payload)} /> : null}
      {DESK_VIEWS.includes(view) ? (
        view === "desk" ? (
          <IntakePage ownerReady={accountOwner} storeLine={deskStoreLine} intake={intake} candidates={state.candidates}
            targetStore={deskPlatform === "ozon" ? deskStore : null} onSubmitLinks={api.submitIntakeLinks}
            onRetry={api.retryIntake} onResume={api.resumeIntake} onOpenCandidate={openDiscoveredCandidate}
            onOpenSeerfar={() => setView("seerfar")} loadStoreProfiles={api.getStoreProfiles} saveStoreProfile={api.saveStoreProfile}
            onOpenBoard={() => setView("board")} onOpenMaintenance={() => setView("maint")} />
        ) : view === "seerfar" ? (<>
          <SelectionDesk
            discoveryView={discoveryView}
            candidates={state.candidates}
            store={deskStore}
            ownerReady={accountOwner}
            loadingLabel={discoveryError ? `读取本店查询结果失败：${discoveryError}` : "正在读取本店的查询结果…"}
            skipped={skippedProducts}
            onSelectProduct={payload => mutateProductDiscovery(api.selectProductDiscovery, payload)}
            onDeclineProduct={payload => mutateProductDiscovery(api.declineProductDiscovery, payload)}
            onLaterProduct={row => setSkippedProducts(current => current.includes(row.key) ? current : [...current, row.key])}
            onEstimate={payload => mutateProductDiscovery(api.estimateProductDiscovery, payload)}
            onTranslate={payload => mutateProductDiscovery(api.translateProductDiscovery, payload)}
            onOpenCandidate={openDiscoveredCandidate}
            onStartNewRound={({ plan, binding, store }) =>
              // One explicit confirmation on the desk, one request: the server creates, authorizes and starts the round
              // in one saved transaction, so a dropped answer can never leave a paid batch that was never started.
              mutateProductDiscovery(api.startProductDiscovery, { planId: plan.planId, planVersion: plan.version, targetStore: store,
                bindingId: binding.bindingId, configurationVersion: binding.configurationVersion,
                expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), idempotencyKey: `desk-round:${crypto.randomUUID()}` })}
            onResumeRound={({ batchId, expectedRevision }) =>
              // An older click that created a batch without a permit: this authorizes that same batch, never a new one.
              mutateProductDiscovery(api.authorizeProductDiscovery, { batchId, expectedRevision,
                expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), idempotencyKey: `desk-permit:${crypto.randomUUID()}` })}
            onOpenBoard={() => setView("board")}
            onOpenInbox={() => setView("inbox")}
            onEliminateCandidate={eliminateCandidate}
            onRestoreCandidate={restoreCandidate}
            onSubmitSourceLink={submitSourceLink}
          />
          {accountOwner ? seerfarError ? <p role="alert">读取 Seerfar 榜单失败：{seerfarError}</p>
            : seerfarView ? <SeerfarWebRoundCard view={seerfarView} onStart={startSeerfarRound} onReadStoreSales={readStoreSales} onOpenCandidate={openDiscoveredCandidate} /> : null : null}
        </>) : view === "board" ? (
          <PipelineBoard candidates={state.candidates} store={deskStore} onOpenCandidate={openDiscoveredCandidate}
            onEliminateCandidate={eliminateCandidate} onRestoreCandidate={restoreCandidate} />
        ) : view === "inbox" ? (
          <OwnerInbox candidates={state.candidates} store={deskStore} onOpenCandidate={openDiscoveredCandidate}
            onEliminateCandidate={eliminateCandidate} onRestoreCandidate={restoreCandidate} onSubmitSourceLink={submitSourceLink} />
        ) : (
          <div className="page-panel">
            <h2>维护</h2>
            <p>这些是以前的页面，行为没有变化。日常判断不需要打开它们。</p>
            <div className="maint-pages">
              {MAINTENANCE_PAGES.map(page => <button key={page.view} type="button" className="button secondary" onClick={() => setView(page.view)}>{page.label}</button>)}
            </div>
            {/* 页面本来就在自动轮询；这个按钮只在轮询因为读取失败停下来时才用得上，所以收在这里。 */}
            <h3>手动操作</h3>
            <p>页面每 3 秒自己读一次共享数据。只有读取失败、轮询停下来时才需要手动刷新。</p>
            <div className="maint-pages">
              <button type="button" className="button secondary"
                onClick={() => { readFailed.current = false; setNotice(null); setPollEpoch(epoch => epoch + 1); }}>刷新数据</button>
            </div>
          </div>
        )
      ) : view === "product" ? (
        !accountOwner ? <div className="page-panel"><p role="status">请先登录主人身份后查看这件商品。</p></div> : <Suspense fallback={<p role="status">正在载入商品页面…</p>}><ProductPage
          preparationSaveState={preparationSaveState}
          candidate={productCandidate}
          view={productDraftView}
          titleZh={productTitleZh}
          extensionStatus={effectiveExtensionStatus}
          loadingLabel={productDraftError ? `读取这件商品的找货资料失败：${productDraftError}` : "正在读取这件商品的找货资料…"}
          onAcceptGate1={payload => runProductStep(api.acceptGate1, payload)}
          onSkipGate1={payload => runProductStep(api.skipGate1, payload)}
          onResolveGate1Shortfall={payload => runProductStep(api.resolveGate1Shortfall, payload)}
          onChooseSkus={payload => runProductStep(api.chooseSourceSkus, payload)}
          onCreateSiblingSku={createSiblingSkuBatch}
          onConfirmSiblingBatchA={confirmSiblingBatchA}
          onConfirmSiblingBatchC1={confirmSiblingBatchC1}
          onPreviewSiblingBatchC1={previewSiblingBatchC1}
          onReadSiblingBatchColorDictionary={readSiblingBatchColorDictionary}
          onAuthorizeSiblingProductionBatch={authorizeSiblingProductionBatch}
          onSaveSiblingBatchStockDrafts={saveSiblingBatchStockDrafts}
          siblingBatchExecutionView={batchExecution?.parentId === productCandidate.id ? batchExecution.view : null}
          siblingBatchExecutionError={batchExecutionError}
          siblingBatchExecutionLoading={accountOwner && batchExecution?.parentId !== productCandidate.id && !batchExecutionError}
          onRefreshSiblingBatchExecution={refreshSiblingBatchExecution}
          onResumeSiblingBatchStock={resumeSiblingBatchStock}
          onUploadSiblingC2Asset={uploadSiblingC2Asset}
          onLinkSiblingC2Asset={linkSiblingC2Asset}
          onConfirmSiblingBatchC2={confirmSiblingBatchC2}
          siblingSkuIds={siblingSkuIds}
          siblingCandidates={siblingCandidates}
          onDeclareCargoFacts={payload => runProductStep(api.declareCargoFacts, payload)}
          onDeclareExtraHandlingFees={payload => runProductStep(api.declareExtraHandlingFees, payload)}
          onDeclareUniformSupply={payload => runProductStep(api.declareSkuUniformSupply, payload)}
          onRequestCapture={payload => requestProductCapture(payload)}
          onReviewCaptureAndRequest={payload => reviewCaptureAndRequest(payload)}
          onRecaptureSource={payload => recaptureProductSource(payload)}
          onReadOzonPage={payload => readOzonProductPage(payload)}
          onStartImageMatch={payload => startSupplierImageMatch(payload)}
          onCompareImageMatch={payload => writeSupplierImageMatch(api.compareSupplierImageMatch, payload)}
          onJudgeImageMatch={payload => writeSupplierImageMatch(api.judgeSupplierImageMatch, payload)}
          onStartOzonMatch={payload => startOzonImageMatch(payload)}
          onCompareOzonMatch={payload => writeSupplierImageMatch(api.compareOzonImageMatch, payload)}
          onJudgeOzonMatch={payload => writeSupplierImageMatch(api.judgeOzonImageMatch, payload)}
          onConfirmProfitStep={payload => confirmProductProfitStep(payload)}
          onRecalculateBWithExactCommission={recalculateBWithExactCommission}
          onRefreshBFeeEvidence={refreshBFeeEvidence}
          productionIdentity={state.runtimeArchitecture?.currentUser}
          onPrepareC1Local={continueC1Preparation}
          onAuthorizeC1PaidDraft={authorizeC1PaidDraft}
          onContinueSavedC1Draft={continueSavedC1Draft}
          onReadOriginalC1DraftResult={readOriginalC1DraftResult}
          onConfirmC1Content={confirmC1Content}
          onConfirmC1EditorialContent={confirmC1EditorialContent}
          onUploadLifecycleFinalAsset={uploadLifecycleFinalAsset}
          onSaveC2UploadDraft={saveC2UploadDraft}
          onConfirmLifecycleFinalAssets={confirmLifecycleFinalAssets}
          onSaveProductionOwnerDecision={saveProductionOwnerDecision}
          onSaveFinalPricingReview={saveFinalPricingReview}
          onReviseC1FinalPlan={reviseC1FinalPlan}
          onReviseSiblingColor={reviseSiblingColor}
          onSaveC1RightsReview={saveC1RightsReview}
          onBackfillC1SupplyAttributes={backfillC1SupplyAttributes}
          onSaveC1OzonAttributeMapping={saveC1OzonAttributeMapping}
          onRefreshC1CategorySchema={refreshC1CategorySchema}
          onProposeC1OzonAttributes={proposeC1OzonAttributes}
          onLoadC1OzonAttributes={api.getC1OzonAttributes}
          onReadC1ColorDictionary={readC1ColorDictionary}
          onOpenLegacyCard={() => setView("review")}
          onEliminateCandidate={eliminateCandidate}
          onBack={() => setView("desk")}
        /></Suspense>
      ) : view==='discovery'?<div className="page-panel">
        {!accountOwner?<p role="status">请先登录主人身份后查看商品发现计划。</p>:<>
          <button type="button" className="button secondary" onClick={()=>setDiscoveryRefresh(value=>value+1)}>刷新发现记录</button>
          {discoveryError?<p role="alert">读取发现记录失败：{discoveryError}</p>:discoveryView?
            <ProductDiscoveryCard view={discoveryView}
              onCreate={payload=>mutateProductDiscovery(api.createProductDiscovery,payload)}
              onAuthorize={payload=>mutateProductDiscovery(api.authorizeProductDiscovery,payload)}
              onContinue={payload=>mutateProductDiscovery(api.continueProductDiscovery,payload)}
              onSelect={payload=>mutateProductDiscovery(api.selectProductDiscovery,payload)}
              onTranslate={payload=>mutateProductDiscovery(api.translateProductDiscovery,payload)}
              onEstimate={payload=>mutateProductDiscovery(api.estimateProductDiscovery,payload)}
              onOpenCandidate={openDiscoveredCandidate}/>:<p role="status">正在读取当前发现计划和保存的批次…</p>}
        </>}
      </div>:view==='accounts'?<div className="page-panel">
        {!accountOwner?<p role="status">请先登录主人身份后查看账户准备。</p>:<>
          <button type="button" className="button secondary" onClick={()=>setAccountRefresh(value=>value+1)}>重新读取准备记录</button>
          {accountPreparationError?<p role="alert">读取账户准备失败：{accountPreparationError}</p>:accountPreparationView?
            <OzonAccountPreparationCard view={accountPreparationView}
              onCreate={payload=>runAccountPreparation(api.createAccountPreparation,payload)}
              onAuthorize={payload=>runAccountPreparation(api.authorizeAccountDiscovery,payload)}
              onContinue={payload=>runAccountPreparation(api.continueAccountDiscovery,payload)}
              onSelectWarehouse={payload=>runAccountPreparation(api.selectAccountWarehouse,payload)}/>:<p role="status">正在读取已保存的账户准备…</p>}
        </>}
      </div>:view === "phase2a" ? (
        <Phase2ASimulation onClose={() => setView("review")} />
      ) : view === "map" ? (
        <ThreeStoreMap
          map={threeStoreMap}
          onClose={() => setView("review")}
          onRefresh={loadThreeStoreMap}
        />
      ) : (
      <>

      <DailyProgress summary={state.summary} />
      <QueueTabs
        active={queue}
        counts={state.summary?.queueCounts}
        onChange={changeQueue}
      />
      <ProcessingBreakdown
        summary={state.summary}
        automationStarted={state.meta?.automationStarted}
      />

      <div className="workspace">
        <CandidateRail
          candidates={state.candidates}
          selectedId={selectedId}
          onSelect={(id) => { selectionGuard.current.changed(); setSelectedId(id); }}
          queue={queue}
          sourceFilter={sourceFilter}
          onSourceFilterChange={changeSourceFilter}
        />
        {selected ? (
          <div className="review-pane" key={selected.id}>
            {detailCandidateId?<>
              {!accountOwner?<p role="status">请先登录主人身份后查看本轮详情准备。</p>:<>
                <button type="button" className="button secondary" onClick={()=>setProductDetailRefresh(value=>value+1)}>重新读取详情准备</button>
                {productDetailError?<p role="alert">读取详情准备失败：{productDetailError}</p>:productDetailView?
                  <ProductDetailPreparationCard key={`${productDetailView.candidateId}:${productDetailView.revision}`} view={productDetailView}
                    onAuthorize={payload=>runProductDetails(api.authorizeProductDetails,payload)}
                    onContinue={payload=>runProductDetails(api.continueProductDetails,payload)}/>:<p role="status">正在读取已保存的详情准备…</p>}
              </>}
            </>:null}
            <CandidateDetail
              candidate={selected}
              seerfarRuntime={state.seerfarRuntime}
              onRealAConfirm={confirmRealAStage}
              onContinueSavedDE={continueSavedDE}
              onDispatchDProductionRound={dispatchDProductionRound}
              onRollbackProductionAuthorization={rollbackProductionAuthorization}
              onRecoverDInitialImport={recoverDInitialImport}
              onReobserveDUnknownOutcome={reobserveDUnknownOutcome}
              onReconcileDFromPlatformState={reconcileDFromPlatformState}
              onAuthorizeAccountRead={payload => runAccountRead(api.authorizeAccountRead, payload)}
              onContinueAccountRead={payload => runAccountRead(api.continueAccountRead, payload)}
            />
            <Suspense fallback={<p role="status">正在载入审核资料…</p>}><UserInspector
              candidate={selected}
              rules={state.rules}
              captureControl={state.captureControl}
              extensionStatus={effectiveExtensionStatus}
              onUpdate={updateSelected}
              onEvaluate={evaluateSelected}
              onComment={commentSelected}
              onMarkListed={markSelectedListed}
              onRecoveryAction={chooseRecoveryAction}
              onStartSourceCapture={startSourceCapture}
              onStartOzonSalesCapture={startOzonSalesCapture}
              onSelectSourceCaptureSku={selectSourceCaptureSku}
              onUploadLifecycleFinalAsset={uploadLifecycleFinalAsset}
              onSaveC2UploadDraft={saveC2UploadDraft}
              onConfirmLifecycleFinalAssets={confirmLifecycleFinalAssets}
              onSaveProductionOwnerDecision={saveProductionOwnerDecision}
              onSaveFinalPricingReview={saveFinalPricingReview}
              onSaveC1RightsReview={saveC1RightsReview}
              onAuthorizeC1PaidDraft={authorizeC1PaidDraft}
              onContinueSavedC1Draft={continueSavedC1Draft}
          onReadOriginalC1DraftResult={readOriginalC1DraftResult}
              onRetryC1KeywordHandoff={retryC1KeywordHandoff}
              onContinueC1Preparation={continueC1Preparation}
              onBackfillC1SupplyAttributes={backfillC1SupplyAttributes}
              onSaveC1OzonAttributeMapping={saveC1OzonAttributeMapping}
              onRefreshC1CategorySchema={refreshC1CategorySchema}
              onProposeC1OzonAttributes={proposeC1OzonAttributes}
              onLoadC1OzonAttributes={api.getC1OzonAttributes}
              onReadC1ColorDictionary={readC1ColorDictionary}
              onRecalculateBWithExactCommission={recalculateBWithExactCommission}
              productionIdentity={state.runtimeArchitecture?.currentUser}
            /></Suspense>
            <CandidateReview candidate={selected} />
          </div>
        ) : (
          <main className="candidate-detail empty-detail">这个队列暂时没有商品</main>
        )}
      </div>

      <OperatingRules rules={state.rules} />

      <footer className="boundary-footer">
        <div>A销售与供应方案确认 → B具体SKU利润 → 自动进入C1 → C2最终素材 → 生产确认；SKU独立生命周期。</div>
        <div>精确1688链接、供应SKU、货价、国内运费、采购成本、重量和尺寸在A阶段完成；B通过后由软件自动进入C1，不再要求主人点开始。上架任务只负责领域开发、验收与异常维护。</div>
        <div>失败立即停止且不自动重试。普通留言不会启动任务；生产写入必须另行确认价格、当前确认卡库存、素材和发布范围。</div>
      </footer>
      </>
      )}
    </div>
  );
}
