import test from "node:test";
import assert from "node:assert/strict";
import { runAndPostWatchtowerReport } from "../src/watchtower/feishuReportJob.js";

test("Watchtower live Sheet report posts a link instead of uploading a file", async () => {
  const sent = [];
  const result = await runAndPostWatchtowerReport({
    runDate: "2026-06-22",
    watchtowerConfig: {
      chatId: "oc_logistics",
      outputDir: "outputs/watchtower",
      createTimeLookbackDays: 30,
      preshipThresholdHours: 48,
      inTransitThresholdHours: 120,
      sheetToken: "sht_test",
      sheetUrl: "https://example.feishu.cn/sheets/sht_test",
    },
    replyClient: {
      async sendTextMessage(...args) {
        sent.push(["text", ...args]);
      },
      async sendFileMessage(...args) {
        sent.push(["file", ...args]);
      },
    },
    watchtowerRunner: async (options) => ({
      spreadsheetUrl: options.spreadsheetUrl,
      source: { rows: 12 },
      findings: { preship: 1, inTransit: 0 },
    }),
  });

  assert.equal(result.postedToFeishu, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "text");
  assert.match(sent[0][2], /https:\/\/example\.feishu\.cn\/sheets\/sht_test/);
});

test("Watchtower file report still uploads XLSX when no live Sheet is configured", async () => {
  const sent = [];
  await runAndPostWatchtowerReport({
    runDate: "2026-06-22",
    watchtowerConfig: {
      chatId: "oc_logistics",
      outputDir: "outputs/watchtower",
      createTimeLookbackDays: 30,
      preshipThresholdHours: 48,
      inTransitThresholdHours: 120,
    },
    replyClient: {
      async sendTextMessage(...args) {
        sent.push(["text", ...args]);
      },
      async sendFileMessage(...args) {
        sent.push(["file", ...args]);
      },
    },
    watchtowerRunner: async () => ({
      outputPath: "/tmp/watchtower.xlsx",
      source: { rows: 12 },
      findings: { preship: 1, inTransit: 0 },
    }),
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], "text");
  assert.equal(sent[1][0], "file");
  assert.equal(sent[1][2], "/tmp/watchtower.xlsx");
});
