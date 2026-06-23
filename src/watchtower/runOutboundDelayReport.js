import path from "node:path";
import { getSurpathConfig } from "../config.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { writeWatchtowerSpreadsheetReport } from "./spreadsheetReport.js";
import { writeWatchtowerLiveSheetReport } from "./liveSheetReport.js";

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

export async function fetchWatchtowerOutboundRows({
  client = new SurpathMcpClient(getSurpathConfig()),
  createTimeStart = dateOnly(daysAgo(30)),
  createTimeEnd = dateOnly(new Date()),
  pageSize = 500,
  maxPages = 200,
} = {}) {
  const rows = [];

  try {
    for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
      const response = await client.queryOutboundOrders({
        createTimeStart,
        createTimeEnd,
        currentPage,
        pageSize,
      });
      rows.push(...(response.data || []));

      const totalSize = Number(response.totalSize || 0);
      if (!response.data?.length || rows.length >= totalSize) {
        break;
      }
    }
  } finally {
    await client.close?.();
  }

  return {
    rows,
    source: {
      createTimeStart,
      createTimeEnd,
      rows: rows.length,
    },
  };
}

export async function runWatchtowerOutboundDelayReport({
  outputDir = "outputs/watchtower",
  outputDate = dateOnly(new Date()),
  outputPath = path.join(outputDir, `watchtower-outbound-delay-${outputDate}.xlsx`),
  actionLogPath = path.join(outputDir, "watchtower-actions.csv"),
  preshipThresholdHours = 48,
  inTransitThresholdHours = 120,
  createTimeStart,
  createTimeEnd,
  pageSize,
  maxPages,
  client,
  feishuClient,
  spreadsheetToken,
  spreadsheetUrl,
  sheetTabs,
} = {}) {
  const { rows, source } = await fetchWatchtowerOutboundRows({
    client,
    createTimeStart,
    createTimeEnd,
    pageSize,
    maxPages,
  });
  const report = spreadsheetToken
    ? await writeWatchtowerLiveSheetReport(rows, {
      client: feishuClient,
      spreadsheetToken,
      spreadsheetUrl,
      sheetTabs,
      reportDate: outputDate,
      preshipThresholdHours,
      inTransitThresholdHours,
    })
    : await writeWatchtowerSpreadsheetReport(rows, {
      outputPath,
      actionLogPath,
      reportDate: outputDate,
      preshipThresholdHours,
      inTransitThresholdHours,
    });

  return {
    ...report,
    source,
  };
}
