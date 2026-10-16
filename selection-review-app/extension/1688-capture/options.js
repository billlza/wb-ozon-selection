import { LOCAL_SERVICE_ORIGIN, normalizeServiceAddress, SERVICE_ADDRESS_MESSAGE_TYPE, SERVICE_STATUS_MESSAGE_TYPE, servicePagePattern }
  from "./capture-request.js";

/**
 * The plugin's settings page: which service this plugin works for. On the owner's own Mac that is the workbench on this
 * computer; on the team's computers it is the team's central service, whose https address is filled in here once.
 * The page only asks; the background checks the address again and keeps it.
 */

async function askBackground(chromeApi, message) {
  try {
    const answer = await chromeApi.runtime.sendMessage(message);
    return answer && typeof answer === "object" ? answer : { saved: false, code: "background_unavailable" };
  } catch {
    return { saved: false, code: "background_unavailable" };
  }
}

// Chrome asks the person to let the plugin onto that one address. It has to be the first thing the click does: Chrome
// shows the question only straight after a click.
export async function connectService(chromeApi, typed) {
  const origin = normalizeServiceAddress(typed);
  if (!origin) return { saved: false, code: "service_address_invalid" };
  if (origin !== LOCAL_SERVICE_ORIGIN) {
    let granted = false;
    try { granted = await chromeApi.permissions.request({ origins: [servicePagePattern(origin)] }); } catch { granted = false; }
    if (granted !== true) return { saved: false, code: "service_access_declined" };
  }
  return askBackground(chromeApi, { type: SERVICE_ADDRESS_MESSAGE_TYPE, serviceOrigin: origin });
}

export function readServiceStatus(chromeApi) {
  return askBackground(chromeApi, { type: SERVICE_STATUS_MESSAGE_TYPE });
}

/** What the page says about the service the plugin works for now: the address, whether it answers, and this computer. */
export function describeService(status) {
  if (!status || typeof status.serviceOrigin !== "string") {
    return { address: "插件后台没有回话，请到 chrome://extensions 重新加载插件。", connection: "", computer: "" };
  }
  const local = status.serviceOrigin === LOCAL_SERVICE_ORIGIN;
  return {
    address: local ? `现在连的是这台电脑上的工作台（${LOCAL_SERVICE_ORIGIN}）。` : `现在连的是团队服务：${status.serviceOrigin}`,
    connection: status.serviceConnected === true ? "已经连上。"
      : status.code === "workstation_not_added" ? "服务连得上，但这台电脑还没加进来，领不了作业。"
      : local ? "还没连上：这台电脑上的工作台可能没开。" : "还没连上：看看网址对不对、网络通不通。",
    computer: local ? "" : status.workstation?.name ? `这台电脑在团队里叫「${status.workstation.name}」。`
      : "这台电脑还没加进来：在这台电脑上打开上面的网址，登录后到「维护」→「干活的电脑」里加一下。"
  };
}

const NOT_SAVED = Object.freeze({
  service_address_invalid: "这个网址用不了：要填团队服务的 https 网址，比如 https://ozon.example.com，后面不带别的路径。",
  service_access_declined: "没有允许插件访问这个网址，所以没改。再点一次，在弹出的框里选「允许」。",
  service_access_missing: "插件还没拿到这个网址的访问许可，所以没改。再点一次，在弹出的框里选「允许」。",
  capture_busy: "插件正在干一个作业，等它做完再改。",
  settings_storage_unavailable: "插件没能存下设置，请到 chrome://extensions 重新加载插件后再试。",
  background_unavailable: "插件后台没有回话，请到 chrome://extensions 重新加载插件后再试。"
});

/** One sentence for what came of the click. */
export function connectMessage(result) {
  if (result?.saved !== true) return NOT_SAVED[result?.code] ?? "没改成，请到 chrome://extensions 重新加载插件后再试。";
  const origin = result.status?.serviceOrigin;
  if (origin === LOCAL_SERVICE_ORIGIN) return "改好了：插件回到这台电脑上的工作台干活。";
  const bridge = result.bridgeReady === false ? "不过插件没能挂到这个网址的页面上，请到 chrome://extensions 重新加载插件。" : "";
  return `改好了：插件以后替 ${origin} 干活。${bridge}下一步：在这台电脑上打开这个网址（已经开着的页面要刷新一下），` +
    "登录后到「维护」→「干活的电脑」把这台电脑加进来。";
}

function startPage(chromeApi, page) {
  const field = (id) => page.getElementById(id);
  const buttons = [field("connect"), field("local")];
  const show = (status) => {
    const view = describeService(status);
    field("address").textContent = view.address;
    field("connection").textContent = view.connection;
    field("computer").textContent = view.computer;
    if (status?.serviceOrigin && status.serviceOrigin !== LOCAL_SERVICE_ORIGIN) field("service-address").value = status.serviceOrigin;
  };
  let busy = false;
  // The action is called before anything is awaited, so Chrome still counts the permission question as part of the click.
  const run = async (action) => {
    if (busy) return;
    busy = true;
    for (const button of buttons) button.disabled = true;
    const pending = action();
    field("message").textContent = "正在改……";
    try {
      const result = await pending;
      field("message").textContent = connectMessage(result);
      if (result?.saved === true) show(result.status);
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
  };
  field("central").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(() => connectService(chromeApi, field("service-address").value));
  });
  field("local").addEventListener("click", () => { void run(() => connectService(chromeApi, LOCAL_SERVICE_ORIGIN)); });
  void readServiceStatus(chromeApi).then((answer) => show(answer.status));
}

if (globalThis.document && globalThis.chrome?.runtime?.id) startPage(globalThis.chrome, globalThis.document);
