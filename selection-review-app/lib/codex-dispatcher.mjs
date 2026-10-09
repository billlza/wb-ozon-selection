import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceCaptureForDispatch } from "./source-capture.mjs";

const DEFAULT_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
// Legacy local maintenance paths; configured catalogs retain their own directory.
const LEGACY_LOCAL_HOME = os.homedir();

const DISPATCH_SKILLS = Object.freeze({
  pricing: Object.freeze({
    name: "ozon-wb-pricing",
    path: path.join(LEGACY_LOCAL_HOME, ".codex", "skills", "ozon-wb-pricing", "SKILL.md")
  }),
  ecommerceSeo: Object.freeze({
    name: "optimize-ecommerce-seo",
    path: path.join(LEGACY_LOCAL_HOME, "Documents", "电商能力实验室", "optimize-ecommerce-seo", "SKILL.md")
  }),
  wbListing: Object.freeze({
    name: "wb-listing-launch",
    path: path.join(LEGACY_LOCAL_HOME, ".codex", "skills", "wb-listing-launch", "SKILL.md")
  }),
  wbSafeWrite: Object.freeze({
    name: "wb-safe-write",
    path: path.join(LEGACY_LOCAL_HOME, ".codex", "skills", "wb-safe-write", "SKILL.md")
  })
});

// A configured directory contains the existing named skills; it does not add
// capabilities or bypass the file-existence check performed before dispatch.
export function createDispatchSkillCatalog({ directory = null } = {}) {
  if (directory === null) return DISPATCH_SKILLS;
  if (typeof directory !== "string" || !directory.trim() || !path.isAbsolute(directory)) {
    throw new Error("DISPATCH_SKILLS_DIRECTORY_INVALID: Skill目录必须为非空绝对路径");
  }
  return Object.freeze(Object.fromEntries(Object.entries(DISPATCH_SKILLS).map(([key, skill]) => [
    key,
    Object.freeze({ name: skill.name, path: path.join(directory, skill.name, "SKILL.md") })
  ])));
}

function plainStatus(status) {
  if (!status) return "unknown";
  return typeof status === "string" ? status : status.type || "unknown";
}

function activeStatusDetail(status) {
  const flags = Array.isArray(status?.activeFlags) ? status.activeFlags.filter(Boolean) : [];
  return flags.length ? `负责人任务存在未结束轮次（${flags.join("、")}）` : "负责人任务存在未结束轮次";
}

function safeMessage(value) {
  return String(value || "").trim().slice(0, 12000);
}

function safePublicUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const DISPATCH_RESULT_TYPES = ["selection_review", "listing_preparation_review", "none"];
const DISPATCH_RESULT_STATUSES = ["completed", "blocked", "needs_decision"];

export const DISPATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: DISPATCH_RESULT_STATUSES },
    reply: { type: "string" },
    resultType: { type: "string", enum: DISPATCH_RESULT_TYPES },
    resultJson: { type: "string" },
    evidenceSummary: { type: "string" }
  },
  required: ["status", "reply", "resultType", "resultJson", "evidenceSummary"],
  additionalProperties: false
};

export function parseDispatchOutput(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("任务没有返回结构化结果");
  if (!DISPATCH_RESULT_STATUSES.includes(parsed.status)) throw new Error("任务返回状态无效");
  if (!DISPATCH_RESULT_TYPES.includes(parsed.resultType)) throw new Error("任务返回结果类型无效");
  const reply = safeMessage(parsed.reply);
  if (!reply) throw new Error("任务没有返回给主人可读的结论");
  return {
    status: parsed.status,
    reply,
    resultType: parsed.resultType,
    resultJson: String(parsed.resultJson || "").trim().slice(0, 100000),
    evidenceSummary: safeMessage(parsed.evidenceSummary)
  };
}

export function dispatchCandidateSnapshot(candidate) {
  if (!candidate) return null;
  return {
    candidateId: String(candidate.id || ""),
    dataRevision: Number(candidate.dataRevision || 0),
    workflowStatus: String(candidate.workflowStatus || ""),
    selectionStage: String(candidate.selectionStage?.stage || candidate.codexReview?.selectionStage || ""),
    source: String(candidate.source || ""),
    targetStore: String(candidate.targetStore || ""),
    productName: safeMessage(candidate.productName).slice(0, 500),
    productUrl: safePublicUrl(candidate.productUrl),
    sourceUrl: safePublicUrl(candidate.sourceUrl),
    competitorUrl: safePublicUrl(candidate.competitorUrl),
    purchasePriceRmb: finiteOrNull(candidate.purchasePriceRmb),
    packagingCostRmb: finiteOrNull(candidate.packagingCostRmb),
    packedWeightKg: finiteOrNull(candidate.packedWeightKg),
    dimensionsCm: {
      length: finiteOrNull(candidate.dimensionsCm?.length),
      width: finiteOrNull(candidate.dimensionsCm?.width),
      height: finiteOrNull(candidate.dimensionsCm?.height)
    },
    expectedPriceRub: finiteOrNull(candidate.expectedPriceRub),
    sellerRevenueCny: finiteOrNull(candidate.sellerRevenueCny),
    powered: candidate.powered ?? "unknown",
    materialsAndAge: safeMessage(candidate.materialsAndAge).slice(0, 1000),
    complianceStatus: String(candidate.complianceStatus || ""),
    authorizationStatus: String(candidate.authorizationStatus || ""),
    defaultStock: finiteOrNull(candidate.defaultStock) ?? 100,
    evidencePackIds: Array.isArray(candidate.evidencePackIds)
      ? candidate.evidencePackIds.map((item) => String(item)).slice(0, 20)
      : [],
    acceptedEstimatedCommission: candidate.acceptedEstimatedCommission || null,
    acceptedTestRisk: candidate.acceptedTestRisk || null,
    bPassedAt: candidate.bPassedAt || null,
    cCompletedAt: candidate.cCompletedAt || null,
    existingReview: candidate.codexReview ? {
      decision: candidate.codexReview.decision || "",
      selectionStage: candidate.codexReview.selectionStage || "",
      reason: safeMessage(candidate.codexReview.reason).slice(0, 2500),
      category: candidate.codexReview.category || null,
      marketEvidence: candidate.codexReview.marketEvidence || null,
      commission: candidate.codexReview.commission || null,
      logistics: candidate.codexReview.logistics || null,
      exchangeRate: candidate.codexReview.exchangeRate || null,
      completeCost: candidate.codexReview.completeCost || null,
      profitCalculation: candidate.codexReview.profitCalculation || null,
      risks: Array.isArray(candidate.codexReview.risks) ? candidate.codexReview.risks.slice(0, 20) : [],
      evidence: Array.isArray(candidate.codexReview.evidence) ? candidate.codexReview.evidence.slice(0, 20) : [],
      reviewedAt: candidate.codexReview.reviewedAt || null
    } : null,
    existingWbAssessment: candidate.wbAssessment || null,
    sourceCapture: sourceCaptureForDispatch(candidate.sourceCapture),
    listingPreparation: candidate.listingPreparation || null,
    listingHandoff: candidate.listingHandoff ? {
      state: candidate.listingHandoff.state || "",
      currentStep: safeMessage(candidate.listingHandoff.currentStep).slice(0, 1000),
      blockReason: safeMessage(candidate.listingHandoff.blockReason).slice(0, 2000),
      defaultStock: finiteOrNull(candidate.listingHandoff.defaultStock) ?? 100
    } : null,
    needsFromUser: Array.isArray(candidate.needsFromUser)
      ? candidate.needsFromUser.map((item) => safeMessage(item).slice(0, 300)).slice(0, 20)
      : [],
    notes: safeMessage(candidate.notes).slice(0, 2000)
  };
}

export function requiredSkillsForDispatch(node, candidate, skillCatalog = DISPATCH_SKILLS) {
  if (!node) return [];
  if (node.id === "M07") {
    return [skillCatalog.pricing, skillCatalog.ecommerceSeo].map((skill) => ({ ...skill }));
  }
  if (node.id === "M10" && candidate?.targetStore === "wb") {
    return [skillCatalog.wbListing, skillCatalog.wbSafeWrite].map((skill) => ({ ...skill }));
  }
  return [];
}

export function dispatchCapabilityPlan(node, candidate, skillCatalog = DISPATCH_SKILLS) {
  const snapshot = dispatchCandidateSnapshot(candidate);
  const sourceCapture = snapshot?.sourceCapture || null;
  return {
    requiredSkills: requiredSkillsForDispatch(node, candidate, skillCatalog),
    inheritedInputs: snapshot ? {
      dataRevision: snapshot.dataRevision,
      targetStore: snapshot.targetStore,
      sourceUrl: snapshot.sourceUrl,
      purchasePriceRmb: snapshot.purchasePriceRmb,
      packedWeightKg: snapshot.packedWeightKg,
      dimensionsCm: snapshot.dimensionsCm
    } : null,
    sourceCapture: sourceCapture ? {
      status: "attached",
      captureId: sourceCapture.captureId,
      offerId: sourceCapture.offerId,
      selectedSkuCount: sourceCapture.selectedSkus.length
    } : {
      status: "not_attached",
      captureId: null,
      offerId: null,
      selectedSkuCount: 0
    }
  };
}

export class CodexDispatcher {
  constructor({
    onEvent,
    enabled = true,
    codexBin = process.env.SELECTION_REVIEW_CODEX_BIN || DEFAULT_CODEX_BIN,
    pathExists = fs.existsSync,
    skillCatalog = DISPATCH_SKILLS
  } = {}) {
    this.onEvent = onEvent || (() => undefined);
    this.enabled = enabled && process.env.SELECTION_REVIEW_CODEX_DISPATCH !== "off";
    this.codexBin = codexBin;
    this.pathExists = pathExists;
    this.skillCatalog = skillCatalog;
    this.process = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.turns = new Map();
    this.threadDispatches = new Map();
    this.dispatchThreads = new Map();
    this.waitingDispatchesByThread = new Map();
    this.approvals = new Map();
    this.initialized = false;
    this.initializing = null;
    this.eventQueue = Promise.resolve();
  }

  emitEvent(event) {
    this.eventQueue = this.eventQueue
      .then(() => this.onEvent(event))
      .catch((error) => console.error("Codex派发事件处理失败", error));
  }

  async ensureStarted() {
    if (!this.enabled) throw new Error("Codex一次性派发已在当前运行环境关闭");
    if (!this.pathExists(this.codexBin)) throw new Error(`找不到Codex本机程序：${this.codexBin}`);
    if (this.process && this.process.exitCode === null && this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = new Promise((resolve, reject) => {
      const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      });
      this.process = child;
      this.initialized = false;
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-5000);
      });
      child.stdout.on("data", (chunk) => this.consume(String(chunk)));
      child.on("error", reject);
      child.on("exit", (code) => {
        const error = new Error(`Codex App Server已停止（${code ?? "unknown"}）：${stderr.trim() || "无更多信息"}`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.process = null;
        this.initialized = false;
        this.initializing = null;
      });

      this.request("initialize", {
        clientInfo: {
          name: "selection-review-app",
          title: "全店经营工作台",
          version: "1.0.0"
        },
        capabilities: { experimentalApi: true }
      }, child).then(() => {
        this.notify("initialized", {}, child);
        this.initialized = true;
        this.initializing = null;
        resolve();
      }).catch((error) => {
        this.initializing = null;
        reject(error);
      });
    });
    return this.initializing;
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try {
          this.handle(JSON.parse(line));
        } catch {}
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  handle(message) {
    if (Object.hasOwn(message, "id") && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex App Server请求失败"));
      else pending.resolve(message.result);
      return;
    }

    const params = message.params || {};
    if (message.method === "thread/status/changed") {
      const threadId = params.threadId;
      const status = plainStatus(params.status);
      const queue = this.waitingDispatchesByThread.get(threadId) || [];
      if (["idle", "notLoaded"].includes(status) && queue.length) {
        const dispatchId = queue.shift();
        if (queue.length) this.waitingDispatchesByThread.set(threadId, queue);
        else this.waitingDispatchesByThread.delete(threadId);
        this.emitEvent({ type: "assignee_available", dispatchId, threadId });
      }
      return;
    }
    const turnId = params.turn?.id || params.turnId || params.item?.turnId;
    const dispatchId = turnId ? this.turns.get(turnId) : null;

    if (Object.hasOwn(message, "id") && message.method) {
      const approvalDispatchId = dispatchId || this.findDispatchByThread(params.threadId);
      if (!approvalDispatchId) {
        this.respond(message.id, { decision: "decline" });
        return;
      }
      const approval = {
        requestId: String(message.id),
        method: message.method,
        reason: safeMessage(params.reason || params.message || "Codex请求本次额外权限"),
        cwd: safeMessage(params.cwd),
        availableDecisions: params.availableDecisions || ["accept", "decline"],
        createdAt: new Date().toISOString()
      };
      this.approvals.set(`${approvalDispatchId}:${message.id}`, message.id);
      this.onEvent({ type: "approval", dispatchId: approvalDispatchId, approval });
      return;
    }

    if (!dispatchId) return;
    if (message.method === "item/agentMessage/delta") {
      this.emitEvent({ type: "assistant_delta", dispatchId, text: safeMessage(params.delta) });
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      const rawText = String(params.item.text || params.item.content || "");
      let structuredResult = null;
      try {
        structuredResult = parseDispatchOutput(rawText);
      } catch {
        structuredResult = null;
      }
      this.emitEvent({
        type: "assistant_message",
        dispatchId,
        text: structuredResult?.reply || safeMessage(rawText),
        structuredResult
      });
    } else if (message.method === "turn/completed") {
      this.emitEvent({
        type: "turn_completed",
        dispatchId,
        turnId,
        status: params.turn?.status || "completed",
        error: safeMessage(params.turn?.error?.message || params.turn?.error)
      });
      this.turns.delete(turnId);
      const threadId = this.dispatchThreads.get(dispatchId);
      if (threadId && this.threadDispatches.get(threadId) === dispatchId) {
        this.threadDispatches.delete(threadId);
      }
      this.dispatchThreads.delete(dispatchId);
    }
  }

  findDispatchByThread(threadId) {
    return this.threadDispatches.get(threadId) || null;
  }

  queueWaitingDispatch(threadId, dispatchId) {
    const queue = this.waitingDispatchesByThread.get(threadId) || [];
    if (!queue.includes(dispatchId)) queue.push(dispatchId);
    this.waitingDispatchesByThread.set(threadId, queue);
  }

  request(method, params, child = this.process) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!child?.stdin?.writable) return reject(new Error("Codex App Server连接不可写"));
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  close() {
    const child = this.process;
    this.process = null;
    this.initialized = false;
    this.initializing = null;
    if (child && child.exitCode === null) child.kill("SIGTERM");
  }

  notify(method, params, child = this.process) {
    if (!child?.stdin?.writable) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async inspectRoute(route) {
    await this.ensureStarted();
    const result = await this.request("thread/read", { threadId: route.threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread) throw new Error("Codex任务不存在");
    if (route.title && thread.name && thread.name !== route.title) {
      throw new Error(`任务标题不一致：期望“${route.title}”，实际“${thread.name}”`);
    }
    const cwd = thread.cwd || thread.session?.cwd || "";
    if (cwd && route.projectPath && cwd !== route.projectPath) {
      throw new Error(`任务项目目录不一致：${cwd}`);
    }
    return { thread, status: plainStatus(thread.status), statusDetail: activeStatusDetail(thread.status) };
  }

  async verifyDesktopTurn(route, turnId, dispatchId) {
    await this.ensureStarted();
    const result = await this.request("thread/turns/list", {
      threadId: route.threadId,
      limit: 5,
      sortDirection: "desc",
      itemsView: "summary"
    });
    const turn = (result?.data || []).find((item) => item?.id === turnId);
    if (!turn) throw new Error("Codex桌面端没有找到指定真实运行编号");
    if (!JSON.stringify(turn).includes(dispatchId)) {
      throw new Error("Codex桌面端本轮内容与原派发编号不一致");
    }
    if (turn.status === "interrupted") {
      try {
        await this.request("thread/resume", { threadId: route.threadId, excludeTurns: true });
      } catch (error) {
        if (/active writer|already has an active writer/i.test(String(error.message || ""))) {
          return { turnId: turn.id, status: "inProgress", liveWriterConfirmed: true };
        }
        throw error;
      }
      throw new Error("Codex桌面端记录显示已中断，且没有检测到当前桌面端写入连接");
    }
    if (!["inProgress", "completed"].includes(turn.status)) {
      throw new Error(`Codex桌面端运行状态不可接管：${turn.status || "unknown"}`);
    }
    return { turnId: turn.id, status: turn.status };
  }

  buildPrompt(dispatch, node, candidate) {
    const scopeText = dispatch.scope === "workflow" ? "整个评审流程" : `当前SKU ${candidate?.id || dispatch.candidateId}`;
    const snapshot = dispatch.candidateSnapshot || dispatchCandidateSnapshot(candidate);
    const selectionInstructions =
      dispatch.assigneeRole === "selection_task" &&
      dispatch.scope === "candidate" &&
      ["M04", "M05", "M06"].includes(node.id)
        ? [
            "本轮只完成A/B选品与利润工作。B阶段不得打开1688，也不得因精确货源、材质、带电、IP或最终包装尚未核验而阻塞利润。",
            "快照里尚未保存市场、佣金、物流或汇率结果，正是本轮选品任务应主动取得的工作，不得把这些项目重新要求主人补充。优先复用仍在适用范围和有效期内的证据；缺失时按当前店铺、类目、销售模式和包装现场只读取证。",
            "只有当前SKU数据已记录主人明确允许时，B阶段才可使用清楚标注的估算佣金；估算费率不得冒充当前平台事实。",
            "B阶段通过时，resultType必须为selection_review，resultJson必须是原codex-review业务结果JSON（无需包含runId和dataRevision）；评审台服务会自行校验并把商品移入待上架准备。选品任务到此停止，不得继续打开1688或执行C阶段。"
          ]
        : [];
    const listingPreparationInstructions =
      dispatch.assigneeRole === "listing_task" &&
      dispatch.scope === "candidate" &&
      node.id === "M07"
        ? [
            "这是主人从评审台明确启动的当前商品C阶段核验，由上架任务负责，不是生产写入授权。",
            "快照中的采购到手总价、真实打包重量、尺寸、目标店铺和精确1688链接均为前期已填写的继承输入；不得重新索取或静默覆盖。只有发现明确冲突时才写needs_decision并指出冲突字段。",
            "若快照带sourceCapture，必须直接使用其中已校验的offerId、captureId和主人选中的一个或多个SKU；不得重新打开1688、控制插件或改用截图兜底。若当前精确1688链接没有已校验采集结果，本轮不得开始。",
            "核验选中SKU、页面直接价格与国内邮费、当前精确佣金和物流、材质、品牌/IP、合规、带电/电池、Schema、素材与必填字段；复用证据包时必须核对适用范围和有效时间。",
            "采集结果中缺少SKU直接价格时：若只选择了一个SKU且priceRanges里存在minimumQuantity=1的明确页面阶梯价，可把它标成商品页面1件起批价证据并单独列国内运费，但不得冒充SKU直取价；除此以外不得拿最低价或默认值补齐。",
            "新品库存默认100，只写入准备结果和确认卡，不得修改店铺库存。若最终成本或证据变化，只更新失效字段并复算利润，不重复整段B历史。",
            "C阶段无论通过、阻塞或待决定，resultType必须为listing_preparation_review，resultJson必须是原listing-preparation-review业务结果JSON（无需包含runId和dataRevision）。使用了1688采集结果时，resultJson必须原样带回sourceCaptureId；评审台会核对后落盘。失败时停止，不自动重试。"
          ]
        : [];
    const requiredSkills = Array.isArray(dispatch.requiredSkills)
      ? dispatch.requiredSkills.map((skill) => skill.name).filter(Boolean)
      : requiredSkillsForDispatch(node, candidate, this.skillCatalog).map((skill) => skill.name);
    return [
      "【全店经营工作台一次性派发】",
      `派发编号：${dispatch.id}`,
      `节点：${node.id} ${node.title}`,
      `范围：${scopeText}`,
      candidate ? `商品：${candidate.productName}` : "商品：无（流程级意见）",
      candidate ? `当前数据修订号：${candidate.dataRevision}` : "当前数据修订号：不适用",
      snapshot ? `本次派发SKU快照：${JSON.stringify(snapshot)}` : "本次派发SKU快照：无（流程级意见）",
      Array.isArray(dispatch.reusableEvidencePacks) && dispatch.reusableEvidencePacks.length
        ? `本轮可复用证据包（必须先核适用范围与有效期）：${JSON.stringify(dispatch.reusableEvidencePacks)}`
        : "本轮可复用证据包：无",
      requiredSkills.length
        ? `本轮评审台已显式附加的必需Skill：${requiredSkills.join("、")}`
        : "本轮没有额外必需Skill。",
      `主人留言：${dispatch.message}`,
      "",
      "只处理这一条明确派发，不领取下一条，不开启连续自动化。上述SKU快照和修订号是本轮开始依据；不要把聊天旧值当成当前事实。",
      "本轮是否已领取由Codex App Server返回的真实turn编号判断。不要连接127.0.0.1:4317，也不要调用评审台本地claim、progress、codex-review、listing-preparation-review或complete接口；执行任务所在环境可能无法反向访问评审台。",
      "最终输出由Codex App Server的outputSchema约束：status写completed、blocked或needs_decision；reply写给主人看的最简单结论；resultType写selection_review、listing_preparation_review或none；resultJson写对应业务结果的JSON字符串，无业务结构时写空字符串；evidenceSummary写最关键证据或失败层。评审台收到最终结构化输出后负责落盘和收口。",
      "直接在当前任务中完成这一个SKU的授权工作。结束时用最简单人话明确写：做到哪里、证据、真实阻塞或待主人决定事项、是否产生任何写入。",
      "没有共享数据回写或独立证据时，只能报告结果未验证，不得自称评审台或平台已完成。",
      ...selectionInstructions,
      ...listingPreparationInstructions,
      "普通节点留言不授权店铺生产写入。涉及平台、店铺、SKU、价格、库存、素材或发布，缺精确生产确认卡时必须停止并写 needs_decision。",
      "若技术失败，说明失败层、是否产生写入和最小恢复动作并立即停止；不得自动重试或自动换路径。"
    ].join("\n");
  }

  async deliver(dispatch, route, node, candidate) {
    const inspected = await this.inspectRoute(route);
    if (inspected.status === "active") {
      try {
        await this.request("thread/resume", { threadId: route.threadId, excludeTurns: true });
      } catch (error) {
        if (/active writer|already has an active writer/i.test(String(error.message || ""))) {
          return {
            status: "blocked",
            detail: "负责人任务被另一客户端占用，无法订阅空闲事件；本轮已停止自动重试",
            failureLayer: "codex_thread_writer_lock"
          };
        }
        throw error;
      }
      this.queueWaitingDispatch(route.threadId, dispatch.id);
      return { status: "waiting_assignee", detail: inspected.statusDetail || "负责人任务存在未结束轮次" };
    }
    if (inspected.status === "systemError") throw new Error("负责人任务当前为systemError，已停止本次派发");
    if (!["idle", "notLoaded"].includes(inspected.status)) throw new Error(`负责人任务状态无法确认：${inspected.status}`);
    try {
      await this.request("thread/resume", { threadId: route.threadId, excludeTurns: true });
    } catch (error) {
      if (/active writer|already has an active writer/i.test(String(error.message || ""))) {
        return {
          status: "blocked",
          detail: "负责人任务由Codex桌面端写入连接占用；本轮未启动，已停止而不是继续假排队",
          failureLayer: "codex_desktop_writer_lock"
        };
      }
      throw error;
    }
    const requiredSkills = requiredSkillsForDispatch(node, candidate, this.skillCatalog);
    for (const skill of requiredSkills) {
      if (!this.pathExists(skill.path)) throw new Error(`本轮必需Skill不存在：${skill.name}`);
    }
    const skillMention = requiredSkills.map((skill) => `$${skill.name}`).join(" ");
    const prompt = this.buildPrompt({ ...dispatch, requiredSkills }, node, candidate);
    let result;
    try {
      result = await this.request("turn/start", {
        threadId: route.threadId,
        input: [
          { type: "text", text: skillMention ? `${skillMention}\n${prompt}` : prompt },
          ...requiredSkills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))
        ],
        cwd: route.projectPath,
        outputSchema: DISPATCH_OUTPUT_SCHEMA
      });
    } catch (error) {
      if (/active writer|already has an active writer|负责人正在处理/i.test(String(error.message || ""))) {
        this.queueWaitingDispatch(route.threadId, dispatch.id);
        return { status: "waiting_assignee", detail: "负责人任务存在未结束轮次，空闲事件到达后自动领取" };
      }
      throw error;
    }
    const turnId = result?.turn?.id;
    if (!turnId) throw new Error("Codex任务没有返回本轮编号");
    this.turns.set(turnId, dispatch.id);
    this.threadDispatches.set(route.threadId, dispatch.id);
    this.dispatchThreads.set(dispatch.id, route.threadId);
    return {
      status: "running",
      turnId,
      detail: "负责人任务已启动，已取得真实运行编号",
      attachedSkills: requiredSkills.map((skill) => skill.name)
    };
  }

  resolveApproval(dispatchId, requestId, decision) {
    const key = `${dispatchId}:${requestId}`;
    const rawId = this.approvals.get(key);
    if (rawId === undefined) throw new Error("权限请求已失效或不属于当前派发");
    this.approvals.delete(key);
    this.respond(rawId, { decision });
  }
}
