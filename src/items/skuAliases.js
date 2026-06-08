const SKU_ALIASES = new Map([
  ["VB010001", "B1 R Ocean Mist"],
  ["VB010002", "B1 L Ocean Mist"],
  ["VB010003", "B1 R Classic Scarlet"],
  ["VB010004", "B1 L Classic Scarlet"],
  ["VB010005", "B1 R Violet Haze"],
  ["VB010006", "B1 L Violet Haze"],
  ["VB010007", "B1 R Satin White"],
  ["VB010008", "B1 L Satin White"],
  ["VB010009", "B1 R Slate Grey"],
  ["VB010010", "B1 L Slate Grey"],
  ["VB010011", "B1 R Lemans Blue"],
  ["VB010012", "B1 L Lemans Blue"],

  ["VD050001", "D2 R Stone Grey"],
  ["VD050002", "D2 L Stone Grey"],
  ["VD050003", "D2 R Pine Green"],
  ["VD050004", "D2 L Pine Green"],
  ["VD050005", "D2 R Cherry Crimson"],
  ["VD050006", "D2 L Cherry Crimson"],
  ["VD050007", "D2 R Mint"],
  ["VD050008", "D2 L Mint"],

  ["VD300001", "D3 R Stone Grey"],
  ["VD300002", "D3 R Cherry Crimson"],
  ["VD300003", "D3 R Lemans Blue"],
  ["VD300004", "D3 R Mint"],
  ["VD300005", "D3 L Stone Grey"],
  ["VD300006", "D3 L Cherry Crimson"],
  ["VD300007", "D3 L Lemans Blue"],
  ["VD300008", "D3 L Emerald Green"],

  ["VDM10001", "DM R Platinum Silver"],
  ["VDM10003", "DM R Olivine Green"],
  ["VDM10004", "DM L Platinum Silver"],
  ["VDM10006", "DM L Olivine Green"],

  ["VF010001", "F1 Stone Grey"],
  ["VF010002", "F1 White"],
  ["VF010003", "F1 Electric Blue"],
  ["VF030001", "F1 Plus Stone Grey"],
  ["VF030002", "F1 Plus White"],
  ["VF030003", "F1 Plus Electric Blue"],
  ["VF030004", "F1 Plus Mango"],
  ["VF030005", "F1 Plus Violet Haze"],

  ["VGM10001", "GM Dark Amber"],
  ["VGM10002", "GM Obsidian"],
  ["VGM10003", "GM Sage"],

  ["VN030001", "N2 ST R Cranberry"],
  ["VN030002", "N2 ST L Cranberry"],
  ["VN030005", "N2 ST R Midnight Blue"],
  ["VN030006", "N2 ST L Midnight Blue"],
  ["VN030007", "N2 ST R Olive"],
  ["VN030008", "N2 ST L Olive"],
  ["VN040001", "N2 HS R Midnight Blue"],
  ["VN040002", "N2 HS L Midnight Blue"],
  ["VN040003", "N2 HS R Sage"],
  ["VN040004", "N2 HS L Sage"],

  ["VN010001", "N2X ST Fig"],
  ["VN010003", "N2X ST Multicam"],
  ["VN010005", "N2X ST Sage"],
  ["VN020001", "N2X HS Obsidian"],
  ["VN020003", "N2X HS Multicam"],
  ["VN020004", "N2X HS Royal Blue"],

  ["VS010001", "S1 R Space Black"],
  ["VS010002", "S1 L Space Black"],
  ["VS010003", "S1 R Sunrise Orange"],
  ["VS010004", "S1 L Sunrise Orange"],
  ["VS010005", "S1 R Royal Blue"],
  ["VS010006", "S1 L Royal Blue"],

  ["VS020001", "S2 R Ocean Blue"],
  ["VS020002", "S2 R Glacial Silver"],
  ["VS020003", "S2 R Galaxy Purple"],
  ["VS020004", "S2 L Ocean Blue"],
  ["VS020005", "S2 L Glacial Silver"],
  ["VS020006", "S2 L Galaxy Purple"],

  ["VT020002", "T1 ST Plus R Sand"],
  ["VT020004", "T1 ST Plus R Lava"],
  ["VT020005", "T1 ST Plus L Sand"],
  ["VT020006", "T1 ST Plus L Lava"],

  ["VT200001", "Tempo MS R Sunset Tangerine"],
  ["VT200002", "Tempo MS R Forest Evergreen"],
  ["VT200003", "Tempo MS L Sunset Tangerine"],
  ["VT200004", "Tempo MS L Forest Evergreen"],
  ["VT210001", "Tempo HS R Lightning Silver"],
  ["VT210002", "Tempo HS R Forest Evergreen"],
  ["VT210003", "Tempo HS L Lightning Silver"],
  ["VT210004", "Tempo HS L Forest Evergreen"],

  ["VTK10001", "Triker Pearl White"],
  ["VTK10002", "Triker Cherry Crimson"],
  ["VTK10003", "Triker Electric Blue"],
]);

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function revisionlessSku(value) {
  return normalizeSku(value).replace(/^(.*\d)[A-Z]$/, "$1");
}

function cleanItemName(value) {
  return String(value || "")
    .replace(/\bVelotric\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function itemDisplayName(item) {
  const sku = normalizeSku(item?.sku);
  if (!sku) {
    return cleanItemName(item?.name) || "Unknown item";
  }

  if (!sku.startsWith("V")) {
    return cleanItemName(item?.name) || sku;
  }

  return SKU_ALIASES.get(sku) || SKU_ALIASES.get(revisionlessSku(sku)) || sku;
}
