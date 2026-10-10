/**
 * 录入页上「店铺档案」卡片的显示和表单逻辑。档案本身由 lib/store-profile.mjs 保存（GET /api/store-profiles、
 * POST /api/store-profiles/:store），这里只把它变成几行字和一个表单，再把表单变回接口要的 values。
 * 校验规则和后台一致（类目最多 20 条、不能重复、同一条不能既要又排除、价格下限不高于上限、预售 0 到 90 天），
 * 只是为了在提交前就说清楚；最后以后台为准。
 */

export const STORE_PROFILE_ORDER = Object.freeze(["miska", "dandanshu"]);
const STORE_NAMES = Object.freeze({ miska: "Miska", dandanshu: "蛋蛋鼠", wb: "WB" });
const PLATFORM_OF_STORE = Object.freeze({ miska: "Ozon", dandanshu: "Ozon", wb: "WB" });

const text = value => (typeof value === "string" ? value.trim() : "");
const isFiniteNumber = value => typeof value === "number" && Number.isFinite(value);

function priceLine(priceRub) {
  const min = isFiniteNumber(priceRub?.min) ? priceRub.min : null;
  const max = isFiniteNumber(priceRub?.max) ? priceRub.max : null;
  if (min === null && max === null) return "不限";
  if (min === null) return `${max} ₽ 以内`;
  if (max === null) return `${min} ₽ 以上`;
  return `${min} 到 ${max} ₽`;
}

function weightLine(grams) {
  if (!isFiniteNumber(grams)) return "不限";
  return grams >= 1000 ? `${Number((grams / 1000).toFixed(2))} kg 以内` : `${grams} g 以内`;
}

/** GET /api/store-profiles 的回执变成卡片；认不出的店排在后面，缺的店不显示。 */
export function storeProfileCards(response) {
  const profiles = response?.profiles && typeof response.profiles === "object" ? response.profiles : {};
  const stores = [...STORE_PROFILE_ORDER.filter(store => profiles[store]), ...Object.keys(profiles).filter(store => !STORE_PROFILE_ORDER.includes(store))];
  return stores.filter(store => profiles[store] && typeof profiles[store] === "object").map(store => {
    const profile = profiles[store];
    const categories = Array.isArray(profile.categoryPaths) ? profile.categoryPaths : [];
    const excluded = Array.isArray(profile.excludedCategoryPaths) ? profile.excludedCategoryPaths : [];
    const skip = profile.skipReasons && typeof profile.skipReasons === "object" ? profile.skipReasons : null;
    return {
      store,
      title: `${PLATFORM_OF_STORE[store] ?? ""}${PLATFORM_OF_STORE[store] ? " · " : ""}${STORE_NAMES[store] ?? store} 的店铺档案`,
      version: text(profile.version),
      sourceLine: profile.source === "owner_edit" ? "你改过的版本" : "默认版本",
      positioning: text(profile.positioning) || "还没写",
      categoriesLine: categories.length === 0 ? "还没写" : categories.join("、"),
      excludedLine: excluded.length === 0 ? null : excluded.join("、"),
      priceLine: priceLine(profile.priceRub),
      weightLine: weightLine(profile.maxWeightGrams),
      presaleLine: Number.isSafeInteger(profile.presaleMaxDays) ? `${profile.presaleMaxDays} 天，晚于这个就提醒你` : "没设",
      skipLine: skip && Number.isSafeInteger(skip.total) && skip.total > 0 ? `你点「不做」记了 ${skip.total} 次原因` : null,
      profile
    };
  });
}

const numberText = value => (isFiniteNumber(value) ? String(value) : "");

/** 一份档案变成表单的初始值：类目一行一条，重量用 kg。 */
export function storeProfileForm(profile) {
  return {
    positioning: text(profile?.positioning),
    categoryPaths: (Array.isArray(profile?.categoryPaths) ? profile.categoryPaths : []).join("\n"),
    excludedCategoryPaths: (Array.isArray(profile?.excludedCategoryPaths) ? profile.excludedCategoryPaths : []).join("\n"),
    priceMin: numberText(profile?.priceRub?.min),
    priceMax: numberText(profile?.priceRub?.max),
    maxWeightKg: isFiniteNumber(profile?.maxWeightGrams) ? String(Number((profile.maxWeightGrams / 1000).toFixed(3))) : "",
    presaleMaxDays: Number.isSafeInteger(profile?.presaleMaxDays) ? String(profile.presaleMaxDays) : ""
  };
}

const lines = value => String(value ?? "").split(/\r?\n/u).map(line => line.trim()).filter(line => line !== "")
  // 类目路径用「 > 」连接，多打或少打空格都按同一种写法存。
  .map(line => line.split(">").map(segment => segment.trim()).filter(segment => segment !== "").join(" > "));

function positiveOrNull(raw, label) {
  const value = text(raw);
  if (value === "") return { value: null };
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return { error: `${label}要填大于 0 的数字，或者留空表示不限` };
  return { value: number };
}

/**
 * 表单变回 POST /api/store-profiles/:store 的 values。错误按字段说一句；有错就不提交。
 */
export function storeProfileValues(form) {
  const errors = [];
  const positioning = text(form?.positioning);
  if (positioning === "") errors.push("店铺定位不能空着");
  if (positioning.length > 200) errors.push("店铺定位最多 200 个字");
  const categoryPaths = lines(form?.categoryPaths);
  const excludedCategoryPaths = lines(form?.excludedCategoryPaths);
  for (const [label, paths] of [["主打类目", categoryPaths], ["不做的类目", excludedCategoryPaths]]) {
    if (paths.length > 20) errors.push(`${label}最多 20 条`);
    if (new Set(paths).size !== paths.length) errors.push(`${label}里有重复的`);
  }
  const both = categoryPaths.filter(path => excludedCategoryPaths.includes(path));
  if (both.length > 0) errors.push(`「${both[0]}」不能既是主打又是不做`);
  const min = positiveOrNull(form?.priceMin, "价格下限");
  const max = positiveOrNull(form?.priceMax, "价格上限");
  if (min.error) errors.push(min.error);
  if (max.error) errors.push(max.error);
  if (!min.error && !max.error && min.value !== null && max.value !== null && min.value > max.value) errors.push("价格下限不能高于上限");
  const weight = positiveOrNull(form?.maxWeightKg, "重量上限");
  if (weight.error) errors.push(weight.error);
  const presaleText = text(form?.presaleMaxDays);
  const presale = Number(presaleText);
  if (presaleText === "" || !Number.isSafeInteger(presale) || presale < 0 || presale > 90) errors.push("预售最多等几天要填 0 到 90 的整数");
  if (errors.length > 0) return { errors, values: null };
  return {
    errors: [],
    values: {
      positioning,
      categoryPaths,
      excludedCategoryPaths,
      priceRub: min.value === null && max.value === null ? null : { min: min.value, max: max.value },
      maxWeightGrams: weight.value === null ? null : Math.round(weight.value * 1000),
      presaleMaxDays: presale
    }
  };
}

/** 保存失败的说法：409 是别处刚改过，要先重新读；404 是档案后台还没合进来。 */
export function storeProfileSaveError(error) {
  if (error?.status === 409) return { conflict: true, message: "店铺档案刚被改过（可能是另一个窗口）。先重新读取，再改一次。" };
  if (error?.status === 404) return { conflict: false, message: STORE_PROFILES_UNAVAILABLE_MESSAGE };
  return { conflict: false, message: `没有保存成功：${error?.message ?? error}` };
}

export const STORE_PROFILES_UNAVAILABLE_MESSAGE = "店铺档案后台还没合进来，暂时看不了也改不了。";
