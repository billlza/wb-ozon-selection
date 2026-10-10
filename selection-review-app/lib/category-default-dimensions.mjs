/**
 * Typical PACKED sizes for the categories this business sells, used only when a discovered product has a captured
 * weight but no package size. These are assumptions for 粗算 (a-discovery-estimate `allowAssumedDimensions`) only,
 * never formal profit: formal profit still requires real dimensions. Values are round, conservative (packed, not bare
 * product) numbers. Rules are ordered most specific first; each `ruleId` is stable so a saved estimate can name the
 * rule it used. Nothing matched → null, and the caller's estimate stays incomplete.
 */
const RULES = Object.freeze([
  { ruleId: 'pet_clothing', lengthCm: 30, widthCm: 25, heightCm: 4, label: '衣服类常见大小',
    keywords: ['宠物服装', '宠物衣服', '衣服', '服装', '背心', '马甲', '雨衣', '卫衣', '外套', 'одежда', 'жилет', 'дождевик', 'комбинезон', 'попона', 'куртка', 'свитер'] },
  { ruleId: 'cat_scratcher', lengthCm: 50, widthCm: 25, heightCm: 8, label: '猫抓板常见大小',
    keywords: ['猫抓板', '抓板', 'когтеточк', 'когтедралк'] },
  { ruleId: 'pet_bed_mat', lengthCm: 50, widthCm: 40, heightCm: 15, label: '宠物窝垫常见大小',
    keywords: ['宠物躺床', '宠物床', '宠物窝', '猫窝', '狗窝', '宠物垫', '猫垫', '狗垫', '睡垫', 'лежанк', 'лежак', 'матрас для', 'коврик для живот'] },
  { ruleId: 'plush_toy', lengthCm: 30, widthCm: 20, heightCm: 15, label: '毛绒玩具常见大小',
    keywords: ['毛绒', '公仔', '玩偶', 'мягкая игрушка', 'плюш'] },
  { ruleId: 'toy_other', lengthCm: 25, widthCm: 20, heightCm: 8, label: '小玩具常见大小',
    keywords: ['玩具', '逗猫', '拼图', '积木', 'игрушк', 'пазл', 'конструктор', 'дразнилк'] },
  { ruleId: 'small_accessory', lengthCm: 15, widthCm: 10, heightCm: 3, label: '小配件常见大小',
    keywords: ['发夹', '发卡', '发圈', '发饰', '头饰', '钥匙扣', '钥匙链', '胸针', 'заколк', 'брелок', 'брелк', 'резинка для волос', 'ободок', 'брошь'] },
  { ruleId: 'home_decor', lengthCm: 20, widthCm: 15, heightCm: 15, label: '家居小摆件常见大小',
    keywords: ['摆件', '装饰', '音乐盒', '八音盒', '花瓶', '相框', '香薰', 'статуэтк', 'декор', 'шкатулк', 'фоторамк', 'ваза', 'интерьер'] },
  { ruleId: 'storage', lengthCm: 35, widthCm: 25, heightCm: 12, label: '收纳用品常见大小',
    keywords: ['收纳', '储物', '整理盒', '整理箱', 'хранени', 'органайзер', 'корзин', 'контейнер'] }
].map(rule => Object.freeze({ ...rule, keywords: Object.freeze(rule.keywords.map(word => word.toLowerCase())) })));

const normalized = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : '');

/** The official type is the strongest signal, then the category path, then the title; within one field the table order decides. */
export function categoryDefaultDimensions({ typeZh = null, typeRu = null, categoryPathZh = null, title = null } = {}) {
  for (const field of [typeZh, typeRu, categoryPathZh, title].map(normalized)) {
    if (field === '') continue;
    const rule = RULES.find(candidate => candidate.keywords.some(word => field.includes(word)));
    if (rule) return { lengthCm: rule.lengthCm, widthCm: rule.widthCm, heightCm: rule.heightCm, label: rule.label, ruleId: rule.ruleId };
  }
  return null;
}
