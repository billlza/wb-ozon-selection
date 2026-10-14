import { cleanCaptureAttributes } from './capture-evidence-sanitization.mjs';

export class SiblingSkuCandidateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SiblingSkuCandidateError';
    this.code = code;
  }
}

/** Internal label only. Ozon title and colour values require the normal C1 confirmation. */
export function siblingSkuCandidateName(parent, choice) {
  const skuId = typeof choice?.sourceSkuId === 'string' ? choice.sourceSkuId.trim() : '';
  const rawColor = choice?.attributes?.颜色;
  const sourceColor = typeof rawColor === 'string' ? rawColor.trim() : '';
  const rawParentName = parent?.productName;
  const parentName = typeof rawParentName === 'string' ? rawParentName.trim() : '';
  const safeText = cleanCaptureAttributes({ 颜色: rawColor, 原商品: parentName });
  if (!/^[1-9][0-9]{0,39}$/.test(skuId) || !sourceColor || sourceColor.length > 120 ||
      !parentName || safeText.颜色 !== sourceColor || safeText.原商品 !== parentName ||
      /[\u0000-\u001f\u007f<>&"'`]/u.test(rawColor) ||
      /[\u0000-\u001f\u007f<>&"'`]/u.test(rawParentName)) {
    throw new SiblingSkuCandidateError('SIBLING_NAME_SOURCE_INVALID',
      '原商品名称或采集颜色不能用于安全的内部命名，请先核对已有资料');
  }
  const prefix = '原商品同款：';
  const suffix = ` · 供应商原色 ${sourceColor} · SKU ${skuId}`;
  const baseLimit = 200 - prefix.length - suffix.length;
  if (baseLimit < 12) {
    throw new SiblingSkuCandidateError('SIBLING_NAME_SOURCE_INVALID', '采集颜色过长，无法生成可辨认的内部名称');
  }
  return `${prefix}${parentName.slice(0, baseLimit).trim()}${suffix}`;
}
