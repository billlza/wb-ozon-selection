/**
 * 部署门禁失败时，决定**哪几行 stderr 可以打出来**。
 *
 * 单独成文件的原因和 lib/ozon-hashtag-attribute.mjs 一样：它的消费方
 * verify-package-with-real-env.mjs 会 spawn 子进程、会 fetch 健康端点，
 * 测试不该把那些能力拖进自己的进程里（CI 的自包含测试策略也会拦）。
 * 这里零 node: 依赖、零副作用。
 *
 * AGENTS 9.4：Token、Cookie、密码和带密钥 URL 不得进入聊天、项目文件、日志或截图。
 *
 * **这道过滤能挡什么、挡不住什么**（别把它当保险箱）：
 * 挡得住带字样的行——`OZON_API_KEY=…`、`Cookie:`、`Bearer …`、`?api_key=…` 这类整行丢弃。
 * 挡不住**光秃秃的值**：如果某行只有一串没有任何提示词的字符串，它仍会被打出来。
 * 所以这只是最后一道纸糊的闸，真正的规矩还是「部署诊断先看服务日志，别往会话里倒 stderr」。
 */

const SECRET_HINTS = /(KEY|TOKEN|SECRET|COOKIE|PASSWORD|CREDENTIAL|Api-Key|ApiKey|Client-Id|ClientId|Authorization|Bearer)/i;
const LOOKS_LIKE_STACK = /Error|throw new|at .*\.mjs/;

/**
 * 只保留像堆栈/抛错的行，并且整行不含任何疑似凭据字样——
 * 宁可少打几行让人自己去查日志，也不赌某一行里不含值。
 * 单行截到 200 字符，最多 8 行。
 */
export function safeDiagnosticLines(stderr) {
  return String(stderr ?? "").split("\n")
    .filter(line => LOOKS_LIKE_STACK.test(line))
    .filter(line => !SECRET_HINTS.test(line))
    .map(line => line.trim().slice(0, 200))
    .slice(0, 8);
}

/** 给测试用：证明某一行「本来会被打出来」，从而证明过滤确实在挡东西。 */
export function looksLikeStackLine(line) { return LOOKS_LIKE_STACK.test(String(line ?? "")); }
