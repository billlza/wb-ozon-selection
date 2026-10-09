/**
 * Ozon 属性 23171 是 Хештеги（主题标签），不是自由搜索词框。
 * 平台规则：每个标签以 # 开头、标签之间用空格分隔、**标签内部不能有空格**。
 *
 * 背心那张卡发出去的是 "хаки Оксфорд Для кошек"（一条、无 #、内部全是空格），
 * 后台判为「#主题标签」格式错误，内容评级被扣。
 *
 * 只做机械变换：逐词加 #、词内空白换下划线；不改词义、不增删词。
 *
 * 这个模块**不许依赖 node: 内置模块**：它同时被浏览器端的最终商品确认卡预览
 * （src/components/FinalProductPlanCard.jsx → lib/ozon-final-product-preview.mjs）
 * 和服务端的 import 请求构建器使用。两边必须用同一份，否则主人在确认卡上
 * 看到的和真正发出去的不是一回事——r69 之前正是各拼各的。
 */
export function ozonHashtagAttributeValue(searchKeywords) {
  const source = Array.isArray(searchKeywords) ? searchKeywords : [];
  const tags = source
    .filter(value => typeof value === "string" && value.trim().length > 0)
    .map(value => `#${value.trim().replace(/\s+/gu, "_")}`);
  if (tags.length === 0) throw new Error("OZON_ADAPTER_CONTENT_GAP: 搜索词未锁定");
  for (const tag of tags) {
    if (!/^#[^\s#]+$/u.test(tag)) {
      throw new Error("OZON_ADAPTER_HASHTAG_REJECTED: 主题标签必须以#开头、内部不能有空格或第二个#");
    }
  }
  return tags.join(" ");
}
