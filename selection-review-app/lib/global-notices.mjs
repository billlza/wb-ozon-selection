/**
 * Page-wide notices and "this run did not happen" to-dos, read from saved records only: the extension status the page
 * already holds, the intake queue's extension flags, each candidate's saved intake blocker and the saved discovery
 * receipts. Nothing here starts, retries or schedules any work. A to-do only offers 重跑; the owner's click is the one
 * thing that ever reruns anything (AGENTS.md §8.3: no automatic retry, unknown_outcome is reconciled, never replayed).
 *
 * The module is pure and imports nothing, so the browser bundle and node tests read the same sentences.
 */

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const list = value => (Array.isArray(value) ? value : []);
const text = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * candidate.intake.blocker.code in a few words (contract: 流程改造-分工与接口.md; piece A writes the record and its own
 * longer sentence in blocker.message, which the to-do repeats as its hint).
 */
export const INTAKE_BLOCKER_LABELS = Object.freeze({
  slider_required: "拼多多或 1688 要你在 Chrome 里拖一下滑块",
  login_pinduoduo_required: "拼多多要你在 Chrome 里登录",
  login_1688_required: "1688 登录过期，等你重新登录",
  plugin_offline: "插件没领这一步，Chrome 关着或插件没开",
  share_link_unresolved: "分享链接没打开到商品页",
  source_delisted: "货源已经下架",
  source_out_of_stock: "货源所有规格都没货",
  presale_too_late: "货源是预售，发货太晚",
  no_source_price: "一个货源价都没读到",
  source_image_missing: "货源页面没读到首图",
  unknown_outcome: "上一次读货源页没等到结果",
  source_unreadable: "这次没读成货源页",
  step_not_started: "这一步没能开始"
});

/** Page-wide blockers stop the whole intake queue; piece A marks them scope "page" and resumes them all at once. */
export const PAGE_BLOCKER_CODES = Object.freeze(["slider_required", "login_pinduoduo_required", "login_1688_required", "plugin_offline"]);

/** These three mean the product has no usable source, so the owner's next step is to paste one. */
export const UNSOURCED_BLOCKER_CODES = Object.freeze(["no_source_price", "source_delisted", "source_out_of_stock"]);

/**
 * Why a saved discovery round stopped, in the owner's words. `rerun` says whether pressing 重跑 can help at all: a
 * configuration or credential problem needs maintenance first, so its to-do carries no button.
 */
export const DISCOVERY_FAILURE_LABELS = Object.freeze({
  AUTHENTICATION_REQUIRED: { reason: "Seerfar 拒绝了查询：登录或授权已过期", rerun: true, hint: "先在 Seerfar 重新登录，再点重跑。" },
  RESPONSE_INVALID: { reason: "Seerfar 返回的内容和以前对不上，可能页面或接口改版了", rerun: false, hint: "需要维护人员先核对，重跑也会同样失败。" },
  RESPONSE_LIMIT: { reason: "Seerfar 返回的条数超出了本轮上限", rerun: false, hint: "需要维护人员核对本轮范围。" },
  RATE_LIMITED: { reason: "Seerfar 限流了", rerun: true, hint: "过一会儿再点重跑。" },
  NETWORK_FAILED: { reason: "网络没连上 Seerfar", rerun: true, hint: "网络恢复后点重跑。" },
  TIMEOUT: { reason: "Seerfar 太久没回应", rerun: true, hint: "可以点重跑再试一次。" },
  PROVIDER_FAILED: { reason: "Seerfar 服务出错", rerun: true, hint: "可以点重跑再试一次。" },
  LEASE_EXPIRED: { reason: "软件在执行中途停下了，请求没有发出", rerun: true, hint: "可以点重跑。" },
  CANCELLED: { reason: "这一轮被取消了", rerun: true, hint: "可以点重跑。" },
  AUTHORIZATION_EXPIRED: { reason: "这一轮的查询许可过期了，没来得及跑", rerun: true, hint: "点重跑会重新确认一次扣点。" },
  BUDGET_EXCEEDED: { reason: "这一轮会超出批准的点数上限，已停下", rerun: false, hint: "需要维护人员核对点数上限。" },
  QUOTA_INVALID: { reason: "Seerfar 返回的剩余点数读不懂", rerun: false, hint: "需要维护人员核对。" },
  CREDENTIAL_MISSING: { reason: "这台电脑上没有 Seerfar 的密钥", rerun: false, hint: "需要维护人员配置。" },
  CREDENTIAL_UNAVAILABLE: { reason: "Seerfar 的密钥读不出来", rerun: false, hint: "需要维护人员核对。" },
  CREDENTIAL_READ_FAILED: { reason: "Seerfar 的密钥读不出来", rerun: false, hint: "需要维护人员核对。" }
});
const FALLBACK_FAILURE = Object.freeze({ reason: null, rerun: false, hint: "需要维护人员核对。" });

export function discoveryFailureLabel(failureClass) {
  const known = DISCOVERY_FAILURE_LABELS[failureClass];
  if (known) return known;
  return { ...FALLBACK_FAILURE, reason: text(failureClass) === null ? "没有记录停止原因" : `软件停下了（${failureClass}）` };
}

/** The extension codes from src/extensionStatus.js that mean nothing can reach Chrome right now. */
const OFFLINE_EXTENSION_CODES = Object.freeze(["disconnected", "background_unavailable"]);

function blockerOf(candidate) {
  const intake = isObject(candidate?.intake) ? candidate.intake : null;
  if (intake?.stage !== "blocked" || !isObject(intake.blocker)) return null;
  return text(intake.blocker.code) === null ? null : intake.blocker;
}

const pageScoped = blocker => blocker.scope === "page" || (blocker.scope === undefined && PAGE_BLOCKER_CODES.includes(blocker.code));

/** Products whose 1688 image search was skipped because 1688 was logged out; 接着找 searches them again. */
const skippedFor1688Login = candidate => candidate?.intake?.skips?.supplierMatch === "login_1688_required";

function activeCandidates(candidates, store) {
  return list(candidates).filter(candidate => isObject(candidate) && candidate.workflowStatus !== "eliminated" &&
    (store === null || store === undefined || candidate.targetStore === store));
}

function waitingCount(candidates, codes) {
  return candidates.filter(candidate => codes.includes(blockerOf(candidate)?.code) || candidate?.intake?.stage === "queued").length;
}

/** The last Seerfar market job anywhere that reached an end, by the instant its receipt saved. */
function latestSeerfarOutcome(discoveryView) {
  let latest = null;
  for (const entry of list(discoveryView?.batches)) {
    if (entry?.batch?.plan?.provider !== "seerfar") continue;
    for (const { job, receipt } of list(entry.jobs)) {
      if (job?.scopeBinding?.request?.method === "supplier_search") continue;
      if (!["completed", "failed", "unknown_outcome"].includes(job?.status)) continue;
      const at = Date.parse(receipt?.completedAt ?? job?.completedAt ?? "");
      if (!Number.isFinite(at)) continue;
      if (latest === null || at > latest.at) latest = { at, status: job.status, failureClass: receipt?.failureClass ?? null };
    }
  }
  return latest;
}

/**
 * The page-wide notices, at most one per kind. Login and plugin problems are said once here instead of on every
 * product (owner draft: 整页的事只在最上面提示一次). The live answer from this tab wins over the server's heartbeat.
 */
export function globalNotices({ extensionStatus = null, queueExtension = null, candidates = [], discoveryView = null, store = null } = {}) {
  const active = activeCandidates(candidates, store);
  const codes = new Set(active.map(candidate => blockerOf(candidate)?.code).filter(Boolean));
  const notices = [];
  const liveConnected = extensionStatus?.code === "connected";
  const offline = !liveConnected && (queueExtension?.online === false || OFFLINE_EXTENSION_CODES.includes(extensionStatus?.code) ||
    codes.has("plugin_offline"));
  if (offline) {
    const waiting = waitingCount(active, ["plugin_offline"]);
    notices.push({ key: "plugin_offline", title: "插件没连上，或者 Chrome 关着",
      detail: `${waiting > 0 ? `${waiting} 件在等，` : ""}排着的商品什么都不会丢。打开 Chrome（插件开着）后，在下面的待办里点「接着找」才会再跑。` });
  }
  if (queueExtension?.login1688 === "expired" || codes.has("login_1688_required")) {
    const waiting = waitingCount(active, ["login_1688_required"]) + active.filter(skippedFor1688Login).length;
    notices.push({ key: "login_1688_expired", title: "1688 登录过期了",
      detail: `${waiting > 0 ? `${waiting} 件要用 1688 的商品先停着，` : "要用 1688 的商品先停着，"}什么都不会丢。在 Chrome 里重新登录 1688；没登录时 1688 只显示没有结果，软件不会当成 1688 上没有同款。`,
      link: { href: "https://login.1688.com/", label: "打开 1688 登录页" } });
  }
  if (codes.has("login_pinduoduo_required")) {
    notices.push({ key: "login_pinduoduo_required", title: "拼多多要你先登录",
      detail: "在你自己的 Chrome 里登录拼多多，然后在下面的待办里点「接着找」。排着的商品什么都不会丢。" });
  }
  if (codes.has("slider_required")) {
    notices.push({ key: "slider_required", title: "拼多多或 1688 要你验证一下",
      detail: "软件不能替你过滑块。在你自己的 Chrome 里打开那个页面拖一下滑块，然后在下面的待办里点「接着找」。" });
  }
  const seerfar = latestSeerfarOutcome(discoveryView);
  if (seerfar?.status === "failed" && seerfar.failureClass === "AUTHENTICATION_REQUIRED") {
    notices.push({ key: "seerfar_login_expired", title: "Seerfar 登录过期了",
      detail: "最近一轮查询被 Seerfar 拒绝了，这一轮没拿到结果。重新登录 Seerfar 后，再在待办里点「重跑」。" });
  } else if (seerfar?.status === "failed" && seerfar.failureClass === "RESPONSE_INVALID") {
    notices.push({ key: "seerfar_page_changed", title: "Seerfar 可能改版了",
      detail: "最近一轮查询返回的内容和以前对不上，软件已经停下，没有把它当成“没有商品”。需要维护人员先核对，重跑会同样失败。" });
  }
  return notices;
}

/** A discovery round's market jobs, newest batch first, for one store. */
function newestRoundForStore(discoveryView, store) {
  return list(discoveryView?.batches)
    .filter(entry => isObject(entry?.batch) && entry.batch.targetStore === store && list(entry.jobs).length > 0)
    .sort((a, b) => (Date.parse(b.batch.createdAt) || 0) - (Date.parse(a.batch.createdAt) || 0))[0] ?? null;
}

/**
 * Every run that did not happen, as one to-do each: the newest discovery round of this store when it stopped, and
 * the intake items stopped on the same retryable reason grouped into one line (five products waiting on a closed
 * Chrome are one problem, not five). Older rounds a newer round already replaced are not to-dos any more.
 */
export function failedRunTodos({ candidates = [], discoveryView = null, store = null, queueExtension = null } = {}) {
  const todos = [];
  const round = store === null ? null : newestRoundForStore(discoveryView, store);
  if (round !== null) {
    const stopped = list(round.jobs).find(({ job }) => job?.scopeBinding?.request?.method !== "supplier_search" &&
      ["failed", "unknown_outcome"].includes(job?.status)) ?? null;
    const running = list(round.jobs).some(({ job }) => ["queued", "claimed", "waiting_platform"].includes(job?.status));
    if (stopped !== null && !running) {
      const direction = text(round.batch.plan?.direction) ?? "未记录方向";
      if (stopped.job.status === "unknown_outcome") {
        todos.push({ key: `discovery:${round.batch.batchId}`, kind: "discovery", title: `查询「${direction}」结果未知`,
          reason: "请求可能已经发出，但没收到确定的结果。", hint: "要先核对这一轮，不能直接重跑，以免重复扣点。", canRerun: false });
      } else {
        const label = discoveryFailureLabel(stopped.receipt?.failureClass ?? null);
        todos.push({ key: `discovery:${round.batch.batchId}`, kind: "discovery", title: `查询「${direction}」没跑成`,
          reason: label.reason, hint: label.hint, canRerun: label.rerun });
      }
    }
  }
  const active = activeCandidates(candidates, store);
  const item = (candidate, blocker) => ({ candidateId: candidate.id, dataRevision: candidate.dataRevision ?? null,
    title: text(candidate.productName) ?? text(candidate.intake?.sourceUrl) ?? candidate.id, message: text(blocker?.message) });
  // Page-wide stops resume together with one 接着找 (piece A's POST /api/intake/resume), so they are one to-do.
  const paused = active.map(candidate => ({ candidate, blocker: blockerOf(candidate) }))
    .filter(({ blocker }) => blocker !== null && blocker.retryable === true && pageScoped(blocker));
  const skipped = queueExtension?.login1688 === "ok" ? active.filter(skippedFor1688Login) : [];
  if (paused.length || skipped.length) {
    const first = paused[0]?.blocker ?? null;
    const reasons = [...new Set(paused.map(({ blocker }) => INTAKE_BLOCKER_LABELS[blocker.code] ?? `软件停下了（${blocker.code}）`))];
    const items = [...paused.map(({ candidate, blocker }) => item(candidate, blocker)), ...skipped.map(candidate => item(candidate, null))];
    todos.push({ key: "intake:resume", kind: "intake_resume", title: `${items.length} 件商品没跑完`,
      reason: [...reasons, ...(skipped.length ? [`${skipped.length} 件因为 1688 没登录跳过了 1688 找同款`] : [])].join("；"),
      hint: `${text(first?.message) === null ? "" : `${text(first.message)}。`}不会自动接着跑，点一次「接着找」，每件只接着跑停下的那一步。`,
      canRerun: true, actionLabel: "接着找", items });
  }
  // A single product that stopped on its own (no first picture, unreadable page, unknown result) reruns by itself.
  const groups = new Map();
  for (const candidate of active) {
    const blocker = blockerOf(candidate);
    if (blocker === null || blocker.retryable !== true || pageScoped(blocker)) continue;
    if (!groups.has(blocker.code)) groups.set(blocker.code, []);
    groups.get(blocker.code).push(item(candidate, blocker));
  }
  for (const [code, items] of groups) {
    const reason = INTAKE_BLOCKER_LABELS[code] ?? items[0].message ?? `软件停下了（${code}）`;
    todos.push({ key: `intake:${code}`, kind: "intake", code, title: items.length === 1 ? `「${items[0].title}」没跑成` : `${items.length} 件商品没跑成`,
      reason, hint: code === "unknown_outcome"
        ? "软件不知道上一次读没读成。点「重跑」就算你知道了，再读一次货源页（只读，不写任何平台）。"
        : "不会自动重跑。点「重跑」，每件只重跑停下的那一步。", canRerun: true, actionLabel: "重跑", items });
  }
  return todos;
}

/** Hosts a pasted source link may come from: the two sources the intake pipeline reads. */
const SOURCE_HOSTS = Object.freeze([
  { kind: "1688", hosts: ["1688.com"] },
  { kind: "pinduoduo", hosts: ["yangkeduo.com", "pinduoduo.com"] }
]);

/** Whether one pasted text is a 1688 or 拼多多 link; the server checks again, this only decides what the form says. */
export function sourceLinkCheck(value) {
  const raw = text(value);
  if (raw === null) return { ok: false, reason: "先贴一个 1688 或拼多多的商品链接。" };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: "这不是一个完整的链接，要以 https:// 开头。" }; }
  if (!["https:", "http:"].includes(url.protocol)) return { ok: false, reason: "这不是一个网页链接。" };
  const host = url.hostname.toLowerCase();
  const match = SOURCE_HOSTS.find(entry => entry.hosts.some(suffix => host === suffix || host.endsWith(`.${suffix}`)));
  if (!match) return { ok: false, reason: "只收 1688 或拼多多的商品链接。" };
  return { ok: true, link: url.toString(), sourceKind: match.kind };
}
