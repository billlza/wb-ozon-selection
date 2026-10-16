/**
 * 团队用中央服务时，每台干活的电脑有自己的一把钥匙（中央服务计划第 3 步）。服务刚给这台电脑做好钥匙，页面立刻把它交给
 * 同一台电脑上的插件：走和开始信号一样的页面→内容脚本通道，只交这一次。钥匙不存在页面里，插件也不把它回传给页面。
 */
export const WORKSTATION_KEY_MESSAGE = "SELECTION_REVIEW_WORKSTATION_KEY";
export const WORKSTATION_KEY_ACK = "SELECTION_REVIEW_WORKSTATION_KEY_ACK";
export const WORKSTATION_KEY_TIMEOUT_MS = 12000;

export function handWorkstationKeyToPlugin({ workstationId, name, key }, page = window) {
  return new Promise((resolve) => {
    const finish = (result) => {
      page.clearTimeout(timer);
      page.removeEventListener("message", receive);
      resolve(result);
    };
    const receive = (event) => {
      if (event.source !== page || event.origin !== page.location.origin || event.data?.type !== WORKSTATION_KEY_ACK ||
          event.data.workstationId !== workstationId) return;
      finish({ accepted: event.data.accepted === true, serviceConnected: event.data.serviceConnected === true,
        code: typeof event.data.code === "string" ? event.data.code : "" });
    };
    page.addEventListener("message", receive);
    // Nothing answered: this tab carries no plugin, so the key reached nobody.
    const timer = page.setTimeout(() => finish({ accepted: false, serviceConnected: false, code: "no_bridge" }), WORKSTATION_KEY_TIMEOUT_MS);
    page.postMessage({ type: WORKSTATION_KEY_MESSAGE, workstationId, name, key }, page.location.origin);
  });
}

const NOT_HANDED_OVER = Object.freeze({
  no_bridge: "这个页面里没有找到插件，钥匙没交出去",
  workstation_storage_unavailable: "插件没能存下钥匙，请到 chrome://extensions 重新加载插件",
  request_origin_invalid: "插件不认这个页面的地址，钥匙没交出去"
});

/** One sentence for what happened to the key. A key the plugin did not take is taken back on the service (`withdrawn`). */
export function workstationKeyMessage(ack, name, { withdrawn = false } = {}) {
  if (ack?.accepted === true) {
    return ack.serviceConnected === true ? `「${name}」加进来了，插件已经连上，可以领作业了。`
      : `「${name}」加进来了，插件收下了钥匙，但还没和服务连上；过半分钟看看上面的插件状态。`;
  }
  const reason = NOT_HANDED_OVER[ack?.code] ?? "插件没收下钥匙";
  return withdrawn ? `${reason}；刚加的「${name}」已经撤掉，刷新页面后再加一次。`
    : `${reason}；刚加的「${name}」没能撤掉，请在下面的名单里把它移除，刷新页面后再加一次。`;
}
