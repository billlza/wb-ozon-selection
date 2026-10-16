import { isWorkstationId } from "./workstation-store.mjs";

// Under team accounts every computer runs its own plugin job, one at a time, instead of one job for the whole service.
// A job a person starts belongs to the computer whose page started it: that page's plugin is the one told to claim it.
// A job the software queues by itself (intake, the gate-1 read) belongs to whichever free computer claims it first.
// One product never has two plugin jobs at once, whichever computers they are on. Without team accounts (the owner's Mac)
// the service keeps its single control and nothing here is used.

/** Sent by a review page with each request once its plugin has said which computer it is on. */
export const PAGE_WORKSTATION_HEADER = "x-selection-review-workstation";
/** For a job the software queues by itself: no computer is chosen until one claims it. */
export const ANY_COMPUTER = "any_computer";

/** The computer a page request says it comes from, or null when it names none or a malformed one. */
export function pageWorkstationId(request) {
  const value = request?.headers?.[PAGE_WORKSTATION_HEADER];
  return isWorkstationId(value) ? value : null;
}

/** Who claimed a plugin job: the plugin's origin, and under team accounts also the computer whose key the call carried. */
export function claimantFor(origin, workstationId = null) {
  return workstationId ? `${origin} ${workstationId}` : origin;
}

export function claimantWorkstationId(claimedBy) {
  const [, workstationId = null] = String(claimedBy || "").split(" ");
  return isWorkstationId(workstationId) ? workstationId : null;
}

/** The computer a job keeps busy: the one it was started for, or the one that claimed it. */
export function captureHolder(session) {
  return (isWorkstationId(session?.assignedTo) ? session.assignedTo : null) ?? claimantWorkstationId(session?.claimedBy);
}

const IDLE_FIELDS = Object.freeze({ candidateId: null, captureId: null, platform: null, captureKind: null, startedAt: null, expiresAt: null });

/** The shape the page reads: the job that holds the control, or none. `job` is one of the open jobs listed by the service. */
export function captureControlView(job, { busyLabel, idleLabel }) {
  if (!job) return { status: "idle", label: idleLabel, ...IDLE_FIELDS };
  return {
    status: "busy",
    label: busyLabel(job),
    candidateId: job.label,
    captureId: job.captureId,
    platform: job.platform,
    captureKind: job.captureKind,
    startedAt: job.jobStatus === "claimed" && Number.isFinite(job.claimedAt) ? new Date(job.claimedAt).toISOString() : null,
    expiresAt: new Date(job.expiresAt).toISOString()
  };
}

const oldestFirst = (left, right) => left.createdAt - right.createdAt;
const computerName = (presence, workstationId) => (workstationId ? presence(workstationId)?.name : null) || null;

/**
 * Why a new plugin job cannot be queued under team accounts, or null when it can. `active` lists every open job
 * ({ captureId, candidateId, label, platform, captureKind, createdAt, claimedAt, expiresAt, jobStatus, holder });
 * `presence(workstationId)` says whether that computer's plugin is online and what it is called.
 */
export function teamCaptureRefusal({ active, candidateId, forComputer, presence }) {
  const anyComputer = forComputer === ANY_COMPUTER;
  if (!anyComputer) {
    if (!isWorkstationId(forComputer)) {
      return { code: "workstation_not_added",
        message: "这台电脑还没加进来，或者插件还没告诉页面它是哪台；作业没有建。到「维护」→「干活的电脑」加一下，刷新页面再点" };
    }
    if (presence(forComputer)?.online !== true) {
      return { code: "workstation_offline",
        message: "这台电脑的插件没连上服务，作业没有建；点浏览器右上角的插件图标，看看连的是不是这个网址" };
    }
  }
  const sameProduct = candidateId === null ? null : active.filter(job => job.candidateId === candidateId).sort(oldestFirst)[0];
  if (sameProduct) {
    const name = computerName(presence, sameProduct.holder);
    return { code: "capture_candidate_busy", job: sameProduct,
      message: name ? `这件商品正由「${name}」采集，等它结束再点；本次没有启动，也不会排队或自动重试`
        : "这件商品已经有一个采集作业在排着或在跑，等它结束再点；本次没有启动，也不会排队或自动重试" };
  }
  if (!anyComputer) {
    const mine = active.filter(job => job.holder === forComputer).sort(oldestFirst)[0];
    if (mine) {
      return { code: "workstation_busy", job: mine,
        message: `这台电脑的插件正在采集 ${mine.label}，等它结束再点；别的电脑照常能用。本次没有启动，也不会排队或自动重试` };
    }
  }
  return null;
}

/** Why this computer may not claim this job, or null. The claim itself still checks everything else about the job. */
export function teamClaimRefusal({ session, active, workstationId }) {
  if (!session) return null;
  if (isWorkstationId(session.assignedTo) && session.assignedTo !== workstationId) {
    return { code: "capture_job_for_other_computer", message: "这次作业分给了别的电脑，这台电脑不能领" };
  }
  if (active.some(job => job.holder === workstationId && job.captureId !== session.captureId)) {
    return { code: "workstation_busy", message: "这台电脑的插件手上还有一个作业，先做完那个" };
  }
  return null;
}

/**
 * What a page under team accounts shows: the job its own computer is running (busy holds only this computer), and the
 * products other computers are reading, so their buttons can say who has them.
 */
export function teamCaptureControl({ active, workstationId, presence }) {
  const mine = isWorkstationId(workstationId) ? active.filter(job => job.holder === workstationId).sort(oldestFirst)[0] ?? null : null;
  const elsewhere = active.filter(job => job !== mine && job.candidateId !== null && (job.holder === null || job.holder !== workstationId))
    .sort(oldestFirst)
    .map(job => ({ candidateId: job.candidateId, platform: job.platform, captureKind: job.captureKind,
      computer: computerName(presence, job.holder) }));
  return {
    ...captureControlView(mine, { busyLabel: job => `这台电脑正在采集 ${job.label}（${job.platform}）`, idleLabel: "这台电脑的采集空闲" }),
    scope: "this_computer",
    elsewhere
  };
}

/**
 * The computers that could take the software's next job now: plugin online, background ready and of the required version,
 * a page on it came for the queue lately (only a page hands a job to its plugin), and nothing running on it.
 */
export function computersReadyForSoftwareJob({ online, active, requiredVersion, pageSeenLately }) {
  const busy = new Set(active.map(job => job.holder).filter(Boolean));
  return online.filter(computer => computer.backgroundReady === true && computer.version === requiredVersion &&
    pageSeenLately(computer.workstationId) && !busy.has(computer.workstationId));
}

