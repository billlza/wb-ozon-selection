import { runtimeArchitectureView } from "./runtimeArchitectureView.js";

/**
 * 顶栏那一个状态指示器。
 *
 * 顶栏原来并排挂着三条工程状态：插件连接、商品采集控制、运行架构。三条平时都正常，于是主人每天打开先看到的是三块
 * 与他无关的字，真正出事的那一条反而混在里面看不出来。这里把三条合成一条：都正常时只有一个圆点和「一切正常」，
 * 任何一条不正常就展开成一句人话，说清楚这件事现在影响他什么。
 *
 * 收起来的是正常，不是异常：原来那三条能表达的每一种不正常，这里都必须说得出来 —— 少说一种就等于顶栏把它藏了。
 * 认不出来的状态一律当成不正常，因为「不知道」和「正常」不是一回事。
 */

export const HEADER_STATUS_OK_LABEL = "一切正常";

const TONE_RANK = Object.freeze({ ok: 0, busy: 1, warning: 2, error: 3 });

/** 插件那条线原来能说的每一种不正常，逐条对上 extensionConnectionStatus 的 code。 */
const EXTENSION_ISSUES = Object.freeze({
  disconnected: { tone: "error", sentence: "插件没连上，现在没法采集1688页面" },
  page_refresh_required: { tone: "warning", sentence: "插件装好了，但这一页还没接上它；刷新这一页才能采集1688页面" },
  reload_required: { tone: "warning", sentence: "插件是旧版本，要在浏览器里重新加载一次，否则采集1688页面会失败" },
  background_unavailable: { tone: "warning", sentence: "插件后台没有响应，现在发不出采集任务" }
});
const EXTENSION_UNKNOWN = { tone: "error", sentence: "插件状态没取到，现在说不准能不能采集1688页面" };

/** 运行架构那条线：本地开发和中央运行都是正常的日常状态，只有读不出来才要说话。 */
const RUNTIME_OK_CODES = Object.freeze(["local_development", "central_ready"]);
const RUNTIME_UNAVAILABLE = { tone: "error", sentence: "运行方式没读出来，现在说不准你的确认会保存到哪里" };

const CAPTURE_UNKNOWN = { tone: "error", sentence: "商品采集控制的状态没取到，现在说不准能不能开始采集" };

const textOf = value => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");

function extensionIssue(status) {
  const code = textOf(status?.code);
  if (code === "connected") return null;
  const known = EXTENSION_ISSUES[code];
  return { source: "extension", code: code || "unknown", ...(known ?? EXTENSION_UNKNOWN) };
}

function captureIssue(control) {
  const status = textOf(control?.status);
  if (status === "idle") return null;
  if (status !== "busy") return { source: "capture", code: status || "unknown", ...CAPTURE_UNKNOWN };
  const candidateId = textOf(control?.candidateId);
  const platform = textOf(control?.platform);
  const who = candidateId === "" ? "另一件商品" : candidateId;
  return {
    source: "capture",
    code: "busy",
    tone: "busy",
    sentence: `${who} 正在采集${platform === "" ? "" : `（${platform}）`}，这会儿别的商品要等它结束`
  };
}

function runtimeIssue(view) {
  if (RUNTIME_OK_CODES.includes(view.code)) return null;
  return { source: "runtime", code: view.code || "unknown", ...RUNTIME_UNAVAILABLE };
}

/**
 * 三条状态合成一条。参数就是原来那三个组件各自读的东西：插件状态、服务端的采集控制快照、运行架构状态。
 * 返回的 issues 是全部不正常的条目（顶栏逐条显示），label 是其中最要紧的那一句，detail 永远带着三条各自的原话，
 * 所以就算收成一个圆点，鼠标停上去仍然能看到「本地开发模式」这类被收起来的正常状态。
 */
export function headerStatusIndicator({ extensionStatus = null, captureControl = null, runtimeArchitecture = null } = {}) {
  const runtime = runtimeArchitectureView(runtimeArchitecture);
  const issues = [extensionIssue(extensionStatus), captureIssue(captureControl), runtimeIssue(runtime)]
    .filter(issue => issue !== null)
    .sort((left, right) => TONE_RANK[right.tone] - TONE_RANK[left.tone]);
  const tone = issues.reduce((worst, issue) => (TONE_RANK[issue.tone] > TONE_RANK[worst] ? issue.tone : worst), "ok");
  const detail = [
    `插件：${textOf(extensionStatus?.label) || "状态未取得"}`,
    `商品采集控制：${textOf(captureControl?.label) || "状态未取得"}`,
    `运行方式：${runtime.label}（${runtime.detail}）`
  ].join("\n");
  return {
    tone,
    ok: issues.length === 0,
    label: issues.length === 0 ? HEADER_STATUS_OK_LABEL : issues[0].sentence,
    issues,
    detail
  };
}
