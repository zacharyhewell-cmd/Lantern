import { getWtfConfig } from "../config.js";

const WTF_TRIGGER_PATTERN = /^\s*wtf\s+(?:ws[-\s]*#?\s*)?(\d{3,})(?:\b|$)/i;
const ORDER_NUMBER_COLUMN_INDEX = 3;
const DISPLAY_COLUMNS = [
  { letter: "A", index: 0 },
  { letter: "M", index: 12 },
  { letter: "Q", index: 16 },
  { letter: "U", index: 20 },
];

function sheetArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.sheets)) {
    return value.sheets;
  }
  return null;
}

function cellText(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    if (value.text != null) {
      return String(value.text);
    }
    if (value.link != null) {
      return String(value.link);
    }
    return JSON.stringify(value);
  }

  return String(value);
}

function normalizeOrderNumber(value) {
  const digits = String(value || "").match(/\d{3,}/)?.[0] || "";
  return digits ? `WS-#${digits}` : "";
}

function valuesFromReadResponse(response) {
  return response?.data?.valueRange?.values ||
    response?.valueRange?.values ||
    response?.values ||
    [];
}

function sheetList(spreadsheetInfo) {
  return sheetArray(spreadsheetInfo?.data?.sheets) ||
    sheetArray(spreadsheetInfo?.data?.spreadsheet?.sheets) ||
    sheetArray(spreadsheetInfo?.spreadsheet?.sheets) ||
    sheetArray(spreadsheetInfo?.sheets) ||
    [];
}

function normalizeSheet(sheet) {
  const properties = sheet?.properties || sheet || {};
  return {
    id: properties.sheet_id || properties.sheetId || properties.id,
    title: properties.title || "",
  };
}

function isMissingSheetIdError(error) {
  return /not found sheetId/i.test(String(error?.message || ""));
}

async function sheetIdsByDiscovery(feishuClient, sheetToken, sheetTitle) {
  if (!feishuClient?.getSpreadsheet) {
    return [];
  }

  let spreadsheetInfo;
  try {
    spreadsheetInfo = await feishuClient.getSpreadsheet(sheetToken);
  } catch {
    return [];
  }

  const sheets = sheetList(spreadsheetInfo)
    .map(normalizeSheet)
    .filter((sheet) => sheet.id);
  const normalizedTitle = String(sheetTitle || "").trim().toLowerCase();

  return sheets
    .filter((sheet) => normalizedTitle && String(sheet.title || "").trim().toLowerCase() === normalizedTitle)
    .map((sheet) => sheet.id);
}

function hasWtfHeaders(values) {
  const headers = values[0] || [];
  return cellText(headers[0]).trim() === "Order SKU" &&
    cellText(headers[3]).trim() === "Order Number" &&
    cellText(headers[12]).trim() === "Product Title" &&
    cellText(headers[16]).trim() === "Covered by Next Inbound" &&
    cellText(headers[20]).trim() === "Next Inbound Date";
}

async function readWtfSheetValues(feishuClient, config, maxRows) {
  const readRange = (sheetId) => feishuClient.readSheetRange(config.sheetToken, `${sheetId}!A1:U${maxRows}`);
  const candidateSheetIds = [
    ...await sheetIdsByDiscovery(feishuClient, config.sheetToken, config.sheetTitle),
    config.sheetId,
  ].filter(Boolean);

  let lastMissingSheetError = null;
  for (const sheetId of [...new Set(candidateSheetIds)]) {
    try {
      const values = valuesFromReadResponse(await readRange(sheetId));
      if (hasWtfHeaders(values)) {
        return values;
      }
    } catch (error) {
      if (!isMissingSheetIdError(error)) {
        throw error;
      }
      lastMissingSheetError = error;
    }
  }

  if (lastMissingSheetError) {
    const tried = [...new Set(candidateSheetIds)].join(", ") || "none";
    throw new Error(`Could not read WTF sheet tab. Tried sheet IDs: ${tried}. Last error: ${lastMissingSheetError.message}`);
  }

  throw new Error(`Could not find WTF sheet tab with expected headers: ${config.sheetTitle || "unknown title"}`);
}

function displayCellValue(row, column) {
  if (column.letter === "U" && /^no$/i.test(cellText(row[16]).trim())) {
    return "Item is at least 2 inbounds away";
  }

  return cellText(row[column.index]) || "Not available";
}

function displayCellLine(headers, row, column) {
  const value = displayCellValue(row, column);
  if (column.letter === "U" && /^no$/i.test(cellText(row[16]).trim())) {
    return value;
  }

  const label = cellText(headers[column.index]) || column.letter;
  return `${label}: ${value}`;
}

export function extractWtfOrderIdentifier(content) {
  const match = String(content || "").match(WTF_TRIGGER_PATTERN);
  if (!match) {
    return null;
  }

  return {
    raw: match[0].trim(),
    digits: match[1],
    canonical: `WS-#${match[1]}`,
  };
}

export function isWtfSheetLookupTrigger(content) {
  return Boolean(extractWtfOrderIdentifier(content));
}

export function findWtfSheetRows(values, orderIdentifier) {
  const target = normalizeOrderNumber(orderIdentifier?.canonical || orderIdentifier);
  if (!target) {
    return [];
  }

  return values
    .slice(1)
    .filter((row) => normalizeOrderNumber(cellText(row[ORDER_NUMBER_COLUMN_INDEX])) === target);
}

export function formatWtfSheetReply({ orderIdentifier, values, rows }) {
  if (!rows.length) {
    return `No matching rows found for ${orderIdentifier.canonical}.`;
  }

  const headers = values[0] || [];
  const lines = [
    `${orderIdentifier.canonical}: ${rows.length} matching row${rows.length === 1 ? "" : "s"}`,
  ];

  rows.forEach((row, index) => {
    lines.push("");
    lines.push(`Row ${index + 1}:`);
    for (const column of DISPLAY_COLUMNS) {
      lines.push(displayCellLine(headers, row, column));
    }
  });

  return lines.join("\n");
}

export async function buildWtfSheetReply(content, {
  feishuClient,
  config = getWtfConfig(),
} = {}) {
  const orderIdentifier = extractWtfOrderIdentifier(content);
  if (!orderIdentifier) {
    return null;
  }

  if (!feishuClient?.readSheetRange) {
    throw new Error("Missing Feishu sheet client");
  }

  if (!config.sheetToken || (!config.sheetId && !config.sheetTitle)) {
    throw new Error("Missing WTF sheet configuration");
  }

  const maxRows = Number.isFinite(config.maxRows) && config.maxRows > 1 ? Math.floor(config.maxRows) : 5000;
  const values = await readWtfSheetValues(feishuClient, config, maxRows);
  const rows = findWtfSheetRows(values, orderIdentifier);

  return formatWtfSheetReply({ orderIdentifier, values, rows });
}
