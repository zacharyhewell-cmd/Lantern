import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  mergeActionEntries,
  parseActionLog,
  serializeActionLog,
  summarizeActionsByOt,
} from "./actionLog.js";
import {
  findInTransitDelayFindings,
  findOutboundDelayFindings,
  groupWatchtowerFindings,
} from "./outboundDelay.js";

const STALE_THRESHOLD_DAYS = 2;
const WATCHTOWER_SHEETS = ["preship FedEx", "preship LtL Other", "In Transit FedEx", "In Transit LtL Other"];

let artifactTool;

async function loadArtifactTool() {
  if (artifactTool) {
    return artifactTool;
  }

  try {
    artifactTool = await import("@oai/artifact-tool");
    return artifactTool;
  } catch (error) {
    const nodePath = process.env.NODE_PATH || "";
    const candidates = nodePath
      .split(path.delimiter)
      .filter(Boolean)
      .map((root) => path.join(root, "@oai", "artifact-tool", "dist", "artifact_tool.mjs"));

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        artifactTool = await import(pathToFileURL(candidate).href);
        return artifactTool;
      } catch {
        // Try the next NODE_PATH entry.
      }
    }

    throw error;
  }
}

async function readActionLog(actionLogPath) {
  try {
    return parseActionLog(await fs.readFile(actionLogPath, "utf8"));
  } catch {
    return [];
  }
}

function isChecked(value) {
  if (value === true) {
    return true;
  }

  const text = String(value || "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "checked", "x"].includes(text);
}

function reportDateFromPath(filePath) {
  const match = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || new Date().toISOString().slice(0, 10);
}

async function checkedActionsFromExistingWorkbook(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    return [];
  }

  const { FileBlob, SpreadsheetFile } = await loadArtifactTool();
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
  const actionDate = reportDateFromPath(filePath);
  const entries = [];

  for (const sheetName of WATCHTOWER_SHEETS) {
    let sheet;
    try {
      sheet = workbook.worksheets.getItem(sheetName);
    } catch {
      continue;
    }

    const values = sheet.getUsedRange().values || [];
    if (values.length < 2) {
      continue;
    }

    const headers = values[0].map((value) => String(value || "").trim());
    const otIndex = headers.indexOf("OT number");
    const actionIndex = headers.indexOf("Action taken?");
    if (otIndex < 0 || actionIndex < 0) {
      continue;
    }

    for (const row of values.slice(1)) {
      if (isChecked(row[actionIndex])) {
        entries.push({ otNumber: row[otIndex], actionDate });
      }
    }
  }

  return entries;
}

function flattenGroupedFindings(findings, groupName) {
  return groupWatchtowerFindings(findings)[groupName]
    .flatMap((order) => order.shipments.map((shipment) => ({
      ...shipment,
      orderSortHours: order.maxElapsedHours,
    })));
}

function formatItems(items) {
  if (!items?.length) {
    return "";
  }

  return items.map((item) => `${item.quantity}x ${item.sku}`).join(", ");
}

function otNumber(finding) {
  return finding.platformCodes?.[0] || finding.shipmentCode || "";
}

function actionCells(finding, actionsByOt) {
  const action = actionsByOt.get(otNumber(finding).toUpperCase());
  return [
    Boolean(action?.actionTaken),
    action?.actionCount || 0,
    action?.lastActionDate || "",
  ];
}

function statusLabel(status) {
  const normalized = String(status || "").trim();
  const lower = normalized.toLowerCase();
  const labels = new Map([
    ["待出库", "Pending outbound"],
    ["已出库-待上网", "Shipped - awaiting pickup"],
    ["派送中", "In transit"],
    ["已妥投", "Delivered"],
    ["已取消", "Canceled"],
  ]);

  if (labels.has(normalized)) {
    return labels.get(normalized);
  }

  if (lower.includes("pending")) return "Pending outbound";
  if (lower.includes("not pickup")) return "Shipped - awaiting pickup";
  if (lower.includes("in transit")) return "In transit";
  if (lower.includes("delivered")) return "Delivered";
  if (lower.includes("cancel")) return "Canceled";
  return normalized || "Unknown";
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function daysSince(value) {
  if (!value) {
    return null;
  }

  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }

  return (Date.now() - time) / (24 * 60 * 60 * 1000);
}

function preshipRows(findings, groupName, actionsByOt) {
  return flattenGroupedFindings(findings, groupName).map((finding) => [
    finding.orderNumber,
    otNumber(finding),
    ...actionCells(finding, actionsByOt),
    round(finding.elapsedHours),
    round(finding.businessElapsedHours),
    finding.warehouseCode || "",
    finding.businessTimeZone || "",
    formatItems(finding.items),
    finding.carrier,
    statusLabel(finding.status),
  ]);
}

function inTransitRows(findings, groupName, actionsByOt) {
  return flattenGroupedFindings(findings, groupName).map((finding) => {
    const staleDays = daysSince(finding.lastTrackTime);
    return [
      finding.orderNumber,
      otNumber(finding),
      ...actionCells(finding, actionsByOt),
      finding.trackingNumber || "",
      round(finding.elapsedDays),
      staleDays == null ? "" : round(staleDays),
      finding.warehouseCode || "",
      finding.destinationState || "",
      formatItems(finding.items),
      finding.carrier,
      statusLabel(finding.status),
    ];
  });
}

function colName(index) {
  let value = "";
  let current = index + 1;
  while (current > 0) {
    const mod = (current - 1) % 26;
    value = String.fromCharCode(65 + mod) + value;
    current = Math.floor((current - mod) / 26);
  }
  return value;
}

function applyDuplicateHighlights(sheet, rowCount) {
  if (rowCount <= 1) {
    return;
  }

  const values = sheet.getRangeByIndexes(1, 0, rowCount - 1, 1).values.flat();
  let lastValue = null;
  let runStart = 0;
  let colorIndex = 0;
  const colors = ["#FFF2CC", "#DDEBF7"];

  function paintRun(endExclusive) {
    if (endExclusive - runStart <= 1) {
      return;
    }
    const color = colors[colorIndex % colors.length];
    sheet.getRangeByIndexes(runStart + 1, 0, endExclusive - runStart, 1).format.fill.color = color;
    colorIndex += 1;
  }

  values.forEach((value, index) => {
    if (index === 0) {
      lastValue = value;
      return;
    }

    if (value !== lastValue) {
      paintRun(index);
      runStart = index;
      lastValue = value;
    }
  });
  paintRun(values.length);
}

function writeSheet(workbook, name, headers, dataRows, options = {}) {
  const sheet = workbook.worksheets.add(name);
  sheet.showGridLines = false;
  const matrix = [headers, ...dataRows];
  const lastCol = colName(headers.length - 1);
  sheet.getRange(`A1:${lastCol}${matrix.length}`).values = matrix;

  const header = sheet.getRange(`A1:${lastCol}1`);
  header.format.fill.color = "#1F4E78";
  header.format.font.color = "#FFFFFF";
  header.format.font.bold = true;
  header.format.wrapText = true;

  const used = sheet.getRange(`A1:${lastCol}${matrix.length}`);
  used.format.font.name = "Aptos";
  used.format.font.size = 11;
  used.format.borders = {
    insideHorizontal: { style: "thin", color: "#E7E6E6" },
    bottom: { style: "thin", color: "#BFBFBF" },
  };
  used.format.wrapText = true;
  sheet.freezePanes.freezeRows(1);

  if (dataRows.length) {
    applyDuplicateHighlights(sheet, matrix.length);
  }

  if (options.numberColumns) {
    for (const columnIndex of options.numberColumns) {
      sheet.getRangeByIndexes(1, columnIndex, Math.max(dataRows.length, 1), 1).format.numberFormat = [["0.0"]];
    }
  }

  if (options.staleColumnIndex != null && dataRows.length) {
    const staleColumnIndex = options.staleColumnIndex;
    dataRows.forEach((row, index) => {
      const value = Number(row[staleColumnIndex]);
      if (Number.isFinite(value) && value > STALE_THRESHOLD_DAYS) {
        sheet.getCell(index + 1, staleColumnIndex).format.fill.color = "#F4CCCC";
      }
    });
  }

  if (options.checkboxColumnIndex != null && dataRows.length) {
    const range = sheet.getRangeByIndexes(1, options.checkboxColumnIndex, dataRows.length, 1);
    range.dataValidation = {
      allowBlank: false,
      list: { inCellDropDown: true, source: ["TRUE", "FALSE"] },
    };
  }

  const widths = options.widths || [];
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, matrix.length, 1).format.columnWidth = width;
  });

  return { sheet, rows: matrix.length };
}

export async function writeWatchtowerSpreadsheetReport(rows, {
  outputPath,
  actionLogPath,
  inspectPath = `${outputPath}.inspect.ndjson`,
  preshipThresholdHours = 48,
  inTransitThresholdHours = 120,
} = {}) {
  if (!outputPath) {
    throw new Error("Missing required outputPath");
  }

  const preshipFindings = findOutboundDelayFindings(rows, { thresholdHours: preshipThresholdHours });
  const inTransitFindings = findInTransitDelayFindings(rows, { thresholdHours: inTransitThresholdHours });
  const actionEntries = mergeActionEntries([
    ...await readActionLog(actionLogPath),
    ...await checkedActionsFromExistingWorkbook(outputPath),
  ]);
  const actionsByOt = summarizeActionsByOt(actionEntries);
  const { SpreadsheetFile, Workbook } = await loadArtifactTool();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (actionLogPath) {
    await fs.mkdir(path.dirname(actionLogPath), { recursive: true });
    await fs.writeFile(actionLogPath, serializeActionLog(actionEntries));
  }

  const workbook = Workbook.create();
  const summaries = [
    writeSheet(
      workbook,
      "preship FedEx",
      ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Hrs late", "Business hrs late", "Origin warehouse code", "Business timezone", "Product SKU", "Carrier", "Status"],
      preshipRows(preshipFindings, "fedex", actionsByOt),
      { checkboxColumnIndex: 2, numberColumns: [3, 5, 6], widths: [14, 22, 15, 13, 16, 10, 17, 20, 24, 42, 16, 24] },
    ),
    writeSheet(
      workbook,
      "preship LtL Other",
      ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Hrs late", "Business hrs late", "Origin warehouse code", "Business timezone", "Product SKU", "Carrier", "Status"],
      preshipRows(preshipFindings, "ltl", actionsByOt),
      { checkboxColumnIndex: 2, numberColumns: [3, 5, 6], widths: [14, 22, 15, 13, 16, 10, 17, 20, 24, 42, 22, 24] },
    ),
    writeSheet(
      workbook,
      "In Transit FedEx",
      ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Tracking", "In Transit Time", "Stale Timer", "Origin warehouse code", "Destination State", "Product SKU", "Carrier", "Status"],
      inTransitRows(inTransitFindings, "fedex", actionsByOt),
      { checkboxColumnIndex: 2, numberColumns: [3, 6, 7], staleColumnIndex: 7, widths: [14, 22, 15, 13, 16, 18, 16, 13, 20, 18, 42, 16, 24] },
    ),
    writeSheet(
      workbook,
      "In Transit LtL Other",
      ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Tracking", "In Transit Time", "Stale Timer", "Origin warehouse code", "Destination State", "Product SKU", "Carrier", "Status"],
      inTransitRows(inTransitFindings, "ltl", actionsByOt),
      { checkboxColumnIndex: 2, numberColumns: [3, 6, 7], staleColumnIndex: 7, widths: [14, 22, 15, 13, 16, 18, 16, 13, 20, 18, 42, 22, 24] },
    ),
  ];

  const inspect = await workbook.inspect({
    kind: "workbook,sheet,table",
    tableMaxRows: 3,
    tableMaxCols: 10,
    maxChars: 20000,
  });
  if (inspectPath) {
    await fs.writeFile(inspectPath, inspect.ndjson);
  }

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(outputPath);

  return {
    outputPath,
    inspectPath,
    actionLogPath,
    findings: {
      preship: preshipFindings.length,
      inTransit: inTransitFindings.length,
    },
    sheets: summaries.map((summary) => ({
      name: summary.sheet.name,
      rows: summary.rows,
    })),
    actionLog: {
      entries: actionEntries.length,
    },
  };
}
