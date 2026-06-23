import { runWatchtowerOutboundDelayReport } from "./runOutboundDelayReport.js";

export function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export async function runAndPostWatchtowerReport({
  watchtowerConfig,
  replyClient,
  watchtowerRunner = runWatchtowerOutboundDelayReport,
  runDate = isoDate(),
} = {}) {
  const result = await watchtowerRunner({
    outputDir: watchtowerConfig.outputDir,
    outputDate: runDate,
    createTimeStart: dateDaysAgo(watchtowerConfig.createTimeLookbackDays),
    createTimeEnd: runDate,
    preshipThresholdHours: watchtowerConfig.preshipThresholdHours,
    inTransitThresholdHours: watchtowerConfig.inTransitThresholdHours,
    feishuClient: replyClient,
    spreadsheetToken: watchtowerConfig.sheetToken,
    spreadsheetUrl: watchtowerConfig.sheetUrl,
    sheetTabs: watchtowerConfig.sheetTabs,
  });

  if (watchtowerConfig.chatId) {
    const reportLink = result.spreadsheetUrl || watchtowerConfig.sheetUrl;
    const findingSummary = `Findings: ${result.findings?.preship ?? 0} preship, ${result.findings?.inTransit ?? 0} in transit.`;
    const summary = reportLink
      ? `Watchtower report for ${runDate} is ready. Source rows scanned: ${result.source.rows}. ${findingSummary}\n${reportLink}`
      : `Watchtower report for ${runDate} is ready. Source rows scanned: ${result.source.rows}. ${findingSummary}`;
    await replyClient.sendTextMessage(watchtowerConfig.chatId, summary, {
      idempotencyKey: `watchtower-summary-${runDate}`,
    });

    if (!reportLink && result.outputPath) {
      await replyClient.sendFileMessage(
        watchtowerConfig.chatId,
        result.outputPath,
        {
          fileName: `watchtower-outbound-delay-${runDate}.xlsx`,
          idempotencyKey: `watchtower-file-${runDate}`,
        },
      );
    }
  }

  return {
    ...result,
    postedToFeishu: Boolean(watchtowerConfig.chatId),
  };
}
