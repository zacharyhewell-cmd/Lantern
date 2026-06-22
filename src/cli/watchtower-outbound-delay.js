import { getSurpathConfig } from "../config.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { findOutboundDelayFindings } from "../watchtower/outboundDelay.js";
import { formatWatchtowerOutboundDelayReport } from "../formatters/watchtowerReport.js";
import { fetchWatchtowerOutboundRows, runWatchtowerOutboundDelayReport } from "../watchtower/runOutboundDelayReport.js";
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

if (format === "xlsx") {
  const result = await runWatchtowerOutboundDelayReport({
    client,
    outputPath,
    actionLogPath,
    preshipThresholdHours: thresholdHours,
    inTransitThresholdHours,
    createTimeStart,
    createTimeEnd,
    pageSize,
    maxPages,
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  const { rows } = await fetchWatchtowerOutboundRows({
    client,
    createTimeStart,
    createTimeEnd,
    pageSize,
    maxPages,
  });
  const findings = findOutboundDelayFindings(rows, { thresholdHours });
  console.log(formatWatchtowerOutboundDelayReport(findings, { thresholdHours }));
}
