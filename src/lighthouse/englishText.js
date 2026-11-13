const HAN_TEXT = /\p{Script=Han}/u;
const HAN_TEXT_GLOBAL = /\p{Script=Han}+/gu;

const PHRASE_TRANSLATIONS = [
  ["已出库-待上网", "Shipped - awaiting carrier scan"],
  ["运输途中", "In transit"],
  ["正在派送", "Out for delivery"],
  ["派送中", "Out for delivery"],
  ["已妥投", "Delivered"],
  ["已签收", "Signed for"],
  ["已送达", "Delivered"],
  ["已取消", "Canceled"],
  ["已揽收", "Picked up by carrier"],
  ["已出库", "Shipped from warehouse"],
  ["待揽收", "Awaiting carrier pickup"],
  ["待提货", "Awaiting pickup"],
  ["待出库", "Pending outbound"],
  ["未出库", "Not yet shipped"],
  ["清关完成", "Customs clearance completed"],
  ["清关", "Customs clearance"],
  ["处理中", "Processing"],
  ["已到达", "Arrived"],
  ["到达", "Arrived"],
  ["离开", "Departed"],
  ["运输", "In transit"],
  ["转运", "In transit"],
  ["包裹", "Package"],
  ["快件", "Shipment"],
  ["仓库", "Warehouse"],
  ["递四方", "4PX"],
  ["中国", "China"],
  ["美国", "United States"],
  ["洛杉矶", "Los Angeles"],
  ["加利福尼亚", "California"],
  ["深圳", "Shenzhen"],
  ["上海", "Shanghai"],
  ["广州", "Guangzhou"],
  ["北京", "Beijing"],
  ["香港", "Hong Kong"],
  ["整车主线", "Main wiring harness"],
  ["中置停车架", "Center kickstand"],
  ["感应卡", "Induction card"],
  ["充电器", "Charger"],
  ["飞轮", "Freewheel"],
  ["仪表", "Display"],
];

function cleanEnglishText(value) {
  let cleaned = value
    .replace(/[（）【】《》、，。；：！？]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:/|()\[\]-]+|[\s,;:/|()\[\]-]+$/g, "")
    .trim();

  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(/\b([A-Za-z][A-Za-z0-9+-]*)\s+\1\b/gi, "$1");
  } while (cleaned !== previous);

  return cleaned;
}

export function containsChineseText(value) {
  return HAN_TEXT.test(String(value || ""));
}

export function toPublicEnglishText(value, { fallback = null } = {}) {
  const source = String(value || "").trim();
  if (!source) {
    return fallback;
  }

  let translated = source;
  for (const [chinese, english] of PHRASE_TRANSLATIONS) {
    translated = translated.replaceAll(chinese, ` ${english} `);
  }

  // Unknown upstream phrases must never leak into the public response. Mixed
  // English/Chinese labels retain their English portion; Chinese-only values
  // use the field-specific English fallback supplied by the caller.
  translated = translated.replace(HAN_TEXT_GLOBAL, " ");
  const cleaned = cleanEnglishText(translated);

  return cleaned && !containsChineseText(cleaned) && /[A-Za-z0-9]/.test(cleaned)
    ? cleaned
    : fallback;
}
