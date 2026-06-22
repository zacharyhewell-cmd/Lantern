import { getSurpathConfig } from "../config.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { findOutboundDelayFindings } from "../watchtower/outboundDelay.js";
import { formatWatchtowerOutboundDelayReport } from "../formatters/watchtowerReport.js";
import path from "node:path";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

const thresholdHours = Number(argValue("--threshold-hours", "48"));
const inTransitThresholdHours = Number(argValue("--in-transit-threshold-hours", "120"));
const pageSize = Number(argValue("--page-size", "500"));
const maxPages = Number(argValue("--max-pages", "200"));
const createTimeStart = argValue("--create-time-start", dateOnly(daysAgo(30)));
const createTimeEnd = argValue("--create-time-end", dateOnly(new Date()));
const format = argValue("--format", "text");
const outputDir = argValue("--output-dir", "outputs/watchtower");
const outputDate = argValue("--output-date", createTimeEnd);
const outputPath = argValue("--output", path.join(outputDir, `watchtower-outbound-delay-${outputDate}.xlsx`));
const actionLogPath = argValue("--action-log", path.join(outputDir, "watchtower-actions.csv"));

const client = new SurpathMcpClient(getSurpathConfig());
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

  if (format === "xlsx") {
    const { writeWatchtowerSpreadsheetReport } = await import("../watchtower/spreadsheetReport.js");
    const result = await writeWatchtowerSpreadsheetReport(rows, {
      outputPath,
      actionLogPath,
      preshipThresholdHours: thresholdHours,
      inTransitThresholdHours,
    });
    console.log(JSON.stringify({
      ...result,
      source: {
        createTimeStart,
        createTimeEnd,
        rows: rows.length,
      },
    }, null, 2));
  } else {
    const findings = findOutboundDelayFindings(rows, { thresholdHours });
    console.log(formatWatchtowerOutboundDelayReport(findings, { thresholdHours }));
  }
} finally {
  await client.close();
}
