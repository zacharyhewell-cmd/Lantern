import { getSurpathConfig } from "../config.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { findOutboundDelayFindings } from "../watchtower/outboundDelay.js";
import { formatWatchtowerOutboundDelayReport } from "../formatters/watchtowerReport.js";

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

const thresholdHours = Number(argValue("--threshold-hours", "72"));
const pageSize = Number(argValue("--page-size", "100"));
const maxPages = Number(argValue("--max-pages", "10"));
const createTimeStart = argValue("--create-time-start", dateOnly(daysAgo(30)));
const createTimeEnd = argValue("--create-time-end", dateOnly(new Date()));

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

  const findings = findOutboundDelayFindings(rows, { thresholdHours });
  console.log(formatWatchtowerOutboundDelayReport(findings, { thresholdHours }));
} finally {
  await client.close();
}

