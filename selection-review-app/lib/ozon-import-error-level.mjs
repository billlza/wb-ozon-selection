/**
 * 导入任务错误的级别判定——**只此一份**。
 *
 * 级别枚举出自 docs/contracts/ozon-de-20260908/official-de-structural-openapi.json 的
 * ErrorErrorLevel：ERROR_LEVEL_UNSPECIFIED / ERROR_LEVEL_ERROR /
 * ERROR_LEVEL_WARNING / ERROR_LEVEL_INTERNAL。
 *
 * ⚠ 该枚举在合同里只被 GetProductInfoListResponseError（/v3/product/info/list）引用；
 * import/info 的 v1ItemError.level 是**裸 string，没有 $ref、没有 enum**。
 * 「两边同一套词」很可能为真，但合同没有明文，所以这里**只认 ERROR_LEVEL_WARNING 为警告，
 * 其余（ERROR / INTERNAL / UNSPECIFIED / 空 / 任何不认识的串）一律按拦路处理**。
 * 最坏结果 = 2026-09-24 当天的行为：停下来留证，绝不误放行。
 *
 * 为什么单独成文件：适配器（判 classification）与观察结果合同（校验 classification）
 * 必须用同一条规则。r69 里预览与适配器各拼各的标签值，导致主人看到的和实际发出的不一致，
 * 同一个教训不重复第二次。本模块不依赖任何 node: 内置模块。
 */
export const OZON_IMPORT_ERROR_WARNING_LEVEL = "ERROR_LEVEL_WARNING";

/** 这一条是不是「拦路的」（即：不是警告）。 */
export function isBlockingImportError(entry) {
  return entry?.level !== OZON_IMPORT_ERROR_WARNING_LEVEL;
}

/** 整组错误里拦路的那些；传入原始条目或已规范化条目都可以，二者 level 字段同名。 */
export function blockingImportErrors(errors) {
  return Array.isArray(errors) ? errors.filter(isBlockingImportError) : [];
}
