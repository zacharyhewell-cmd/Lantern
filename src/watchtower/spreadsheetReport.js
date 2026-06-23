import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
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

export const STALE_THRESHOLD_DAYS = 2;
export const WATCHTOWER_SHEETS = ["preship FedEx", "preship LtL Other", "In Transit FedEx", "In Transit LtL Other"];

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

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const actionDate = reportDateFromPath(filePath);
  const entries = [];

  for (const sheetName of WATCHTOWER_SHEETS) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      continue;
    }

    if (sheet.rowCount < 2) {
      continue;
    }

    const headers = sheet.getRow(1).values.slice(1).map((value) => String(value || "").trim());
    const otIndex = headers.indexOf("OT number");
    const actionIndex = headers.indexOf("Action taken?");
    if (otIndex < 0 || actionIndex < 0) {
      continue;
    }

    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      if (isChecked(row.getCell(actionIndex + 1).value)) {
        entries.push({ otNumber: row.getCell(otIndex + 1).value, actionDate });
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

function actionCells(finding, actionsByOt, reportDate) {
  const action = actionsByOt.get(otNumber(finding).toUpperCase());
  const actionTakenToday = Boolean(reportDate && action?.actionDates?.has(reportDate));
  return [
    actionTakenToday,
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

function preshipRows(findings, groupName, actionsByOt, reportDate) {
  return flattenGroupedFindings(findings, groupName).map((finding) => [
    finding.orderNumber,
    otNumber(finding),
    ...actionCells(finding, actionsByOt, reportDate),
    round(finding.elapsedHours),
    round(finding.businessElapsedHours),
    finding.warehouseCode || "",
    finding.businessTimeZone || "",
    formatItems(finding.items),
    finding.carrier,
    statusLabel(finding.status),
  ]);
}

function inTransitRows(findings, groupName, actionsByOt, reportDate) {
  return flattenGroupedFindings(findings, groupName).map((finding) => {
    const staleDays = daysSince(finding.lastTrackTime);
    return [
      finding.orderNumber,
      otNumber(finding),
      ...actionCells(finding, actionsByOt, reportDate),
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

export function buildWatchtowerSheetReport(rows, {
  actionEntries = [],
  reportDate = new Date().toISOString().slice(0, 10),
  preshipThresholdHours = 48,
  inTransitThresholdHours = 120,
} = {}) {
  const preshipFindings = findOutboundDelayFindings(rows, { thresholdHours: preshipThresholdHours });
  const inTransitFindings = findInTransitDelayFindings(rows, { thresholdHours: inTransitThresholdHours });
  const actionsByOt = summarizeActionsByOt(actionEntries);
  const sheets = [
    {
      name: "preship FedEx",
      headers: ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Hrs late", "Business hrs late", "Origin warehouse code", "Business timezone", "Product SKU", "Carrier", "Status"],
      rows: preshipRows(preshipFindings, "fedex", actionsByOt, reportDate),
      options: { checkboxColumnIndex: 2, numberColumns: [3, 5, 6], widths: [14, 22, 15, 13, 16, 10, 17, 20, 24, 42, 16, 24] },
    },
    {
      name: "preship LtL Other",
      headers: ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Hrs late", "Business hrs late", "Origin warehouse code", "Business timezone", "Product SKU", "Carrier", "Status"],
      rows: preshipRows(preshipFindings, "ltl", actionsByOt, reportDate),
      options: { checkboxColumnIndex: 2, numberColumns: [3, 5, 6], widths: [14, 22, 15, 13, 16, 10, 17, 20, 24, 42, 22, 24] },
    },
    {
      name: "In Transit FedEx",
      headers: ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Tracking", "In Transit Days", "Stale Days", "Origin warehouse code", "Destination State", "Product SKU", "Carrier", "Status"],
      rows: inTransitRows(inTransitFindings, "fedex", actionsByOt, reportDate),
      options: { checkboxColumnIndex: 2, numberColumns: [3, 6, 7], staleColumnIndex: 7, widths: [14, 22, 15, 13, 16, 18, 16, 13, 20, 18, 42, 16, 24] },
    },
    {
      name: "In Transit LtL Other",
      headers: ["WS#", "OT number", "Action taken?", "Action count", "Last action date", "Tracking", "In Transit Days", "Stale Days", "Origin warehouse code", "Destination State", "Product SKU", "Carrier", "Status"],
      rows: inTransitRows(inTransitFindings, "ltl", actionsByOt, reportDate),
      options: { checkboxColumnIndex: 2, numberColumns: [3, 6, 7], staleColumnIndex: 7, widths: [14, 22, 15, 13, 16, 18, 16, 13, 20, 18, 42, 22, 24] },
    },
  ];

  return {
    findings: {
      preship: preshipFindings.length,
      inTransit: inTransitFindings.length,
    },
    sheets,
  };
}

function applyDuplicateHighlights(sheet, rowCount) {
  if (rowCount <= 1) {
    return;
  }

  const values = [];
  for (let rowIndex = 2; rowIndex <= rowCount; rowIndex += 1) {
    values.push(sheet.getRow(rowIndex).getCell(1).value);
  }

  let lastValue = null;
  let runStart = 0;
  let colorIndex = 0;
  const colors = ["FFFFF2CC", "FFDDEBF7"];

  function paintRun(endExclusive) {
    if (endExclusive - runStart <= 1) {
      return;
    }
    const color = colors[colorIndex % colors.length];
    for (let rowIndex = runStart + 2; rowIndex < endExclusive + 2; rowIndex += 1) {
      sheet.getRow(rowIndex).getCell(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: color },
      };
    }
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
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
    properties: { showGridLines: false },
  });
  sheet.columns = headers.map((header, index) => ({
    header,
    key: `c${index}`,
    width: options.widths?.[index] || 16,
  }));
  dataRows.forEach((row) => sheet.addRow(row));

  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.font = { name: "Aptos", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { wrapText: true, vertical: "middle" };
  });

  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.font = cell.font || { name: "Aptos", size: 11 };
      cell.alignment = { wrapText: true, vertical: "top" };
      cell.border = {
        bottom: { style: "thin", color: { argb: "FFBFBFBF" } },
      };
    });
  });

  if (dataRows.length) {
    applyDuplicateHighlights(sheet, sheet.rowCount);
  }

  if (options.numberColumns) {
    for (const columnIndex of options.numberColumns) {
      for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
        sheet.getRow(rowIndex).getCell(columnIndex + 1).numFmt = "0.0";
      }
    }
  }

  if (options.staleColumnIndex != null && dataRows.length) {
    const staleColumnIndex = options.staleColumnIndex;
    dataRows.forEach((row, index) => {
      const value = Number(row[staleColumnIndex]);
      if (Number.isFinite(value) && value > STALE_THRESHOLD_DAYS) {
        sheet.getRow(index + 2).getCell(staleColumnIndex + 1).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF4CCCC" },
        };
      }
    });
  }

  if (options.checkboxColumnIndex != null && dataRows.length) {
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      sheet.getRow(rowIndex).getCell(options.checkboxColumnIndex + 1).dataValidation = {
        type: "list",
        allowBlank: false,
        formulae: ["\"TRUE,FALSE\""],
      };
    }
  }

  return { sheet, rows: sheet.rowCount };
}

export async function writeWatchtowerSpreadsheetReport(rows, {
  outputPath,
  actionLogPath,
  inspectPath = `${outputPath}.inspect.ndjson`,
  preshipThresholdHours = 48,
  inTransitThresholdHours = 120,
  reportDate = reportDateFromPath(outputPath),
} = {}) {
  if (!outputPath) {
    throw new Error("Missing required outputPath");
  }

  const actionEntries = mergeActionEntries([
    ...await readActionLog(actionLogPath),
    ...await checkedActionsFromExistingWorkbook(outputPath),
  ]);
  const report = buildWatchtowerSheetReport(rows, {
    actionEntries,
    reportDate,
    preshipThresholdHours,
    inTransitThresholdHours,
  });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Lantern Watchtower";
  workbook.created = new Date();
  workbook.modified = new Date();

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  if (actionLogPath) {
    await fs.mkdir(path.dirname(actionLogPath), { recursive: true });
    await fs.writeFile(actionLogPath, serializeActionLog(actionEntries));
  }

  const summaries = [
    ...report.sheets.map((sheet) => writeSheet(
      workbook,
      sheet.name,
      sheet.headers,
      sheet.rows,
      sheet.options,
    )),
  ];

  if (inspectPath) {
    await fs.writeFile(inspectPath, summaries.map((summary) => JSON.stringify({
      sheet: summary.sheet.name,
      rows: summary.rows,
      columns: summary.sheet.columnCount,
    })).join("\n"));
  }

  await workbook.xlsx.writeFile(outputPath);

  return {
    outputPath,
    inspectPath,
    actionLogPath,
    findings: report.findings,
    sheets: summaries.map((summary) => ({
      name: summary.sheet.name,
      rows: summary.rows,
    })),
    actionLog: {
      entries: actionEntries.length,
    },
  };
}
