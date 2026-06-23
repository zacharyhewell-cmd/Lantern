import test from "node:test";
import assert from "node:assert/strict";
import { writeWatchtowerLiveSheetReport } from "../src/watchtower/liveSheetReport.js";

function row(overrides = {}) {
  return {
    customerPlatformCode: "WS-#33000",
    platformCode: "OT1",
    expressNumber: "873097980414",
    expressFromCode: "US_FEDEX_GROUND",
    status: "待出库",
    createTime: Date.UTC(2026, 5, 1, 12),
    actualOutboundDate: null,
    warehouseCode: "LA-A",
    sku: "SKU-1",
    quantity: 1,
    ...overrides,
  };
}

function fakeSheetClient() {
  const ranges = new Map();
  const calls = [];
  const sheets = [
    { id: "pfx", title: "preship FedEx" },
    { id: "plt", title: "preship LtL Other" },
    { id: "ifx", title: "In Transit FedEx" },
    { id: "ilt", title: "In Transit LtL Other" },
    { id: "log", title: "_Watchtower Actions" },
  ];

  return {
    calls,
    ranges,
    async getSpreadsheet() {
      return {
        data: {
          sheets: {
            sheets: sheets.map((sheet) => ({
              sheet_id: sheet.id,
              title: sheet.title,
            })),
          },
        },
      };
    },
    async batchUpdateSheets(_token, requests) {
      calls.push(["batchUpdateSheets", requests]);
    },
    async readSheetRange(_token, range) {
      calls.push(["readSheetRange", range]);
      return { data: { valueRange: { values: ranges.get(range) || [] } } };
    },
    async writeSheetRange(_token, range, values) {
      calls.push(["writeSheetRange", range, values]);
      ranges.set(range, values);
    },
    async setSheetDropdown(_token, range, values) {
      calls.push(["setSheetDropdown", range, values]);
    },
    async setSheetStyle(_token, range, style) {
      calls.push(["setSheetStyle", range, style]);
    },
  };
}

function fakeSheetClientWithMetadataShapes(metadataResponses) {
  const calls = [];
  const ranges = new Map();
  let metadataIndex = 0;
  return {
    calls,
    ranges,
    async getSpreadsheet() {
      const response = metadataResponses[Math.min(metadataIndex, metadataResponses.length - 1)];
      metadataIndex += 1;
      return response;
    },
    async batchUpdateSheets(_token, requests) {
      calls.push(["batchUpdateSheets", requests]);
    },
    async readSheetRange(_token, range) {
      calls.push(["readSheetRange", range]);
      return { data: { valueRange: { values: ranges.get(range) || [] } } };
    },
    async writeSheetRange(_token, range, values) {
      calls.push(["writeSheetRange", range, values]);
      ranges.set(range, values);
    },
    async setSheetDropdown(_token, range, values) {
      calls.push(["setSheetDropdown", range, values]);
    },
    async setSheetStyle(_token, range, style) {
      calls.push(["setSheetStyle", range, style]);
    },
  };
}

function sheetInfoArrayShape() {
  return {
    data: {
      sheets: [
        { sheet_id: "pfx", title: "preship FedEx" },
        { sheet_id: "plt", title: "preship LtL Other" },
        { sheet_id: "ifx", title: "In Transit FedEx" },
        { sheet_id: "ilt", title: "In Transit LtL Other" },
        { sheet_id: "log", title: "_Watchtower Actions" },
      ],
    },
  };
}

test("live sheet report captures checked actions and rewrites the shared report", async () => {
  const client = fakeSheetClient();
  client.ranges.set("pfx!A1:M2000", [
    ["WS#", "OT number", "Action taken?"],
    ["WS-#33000", "OT1", "TRUE"],
  ]);
  client.ranges.set("log!A1:B20000", [
    ["OT number", "Action date"],
    ["OT1", "2026-06-21"],
  ]);

  const result = await writeWatchtowerLiveSheetReport([row()], {
    client,
    spreadsheetToken: "sht_test",
    spreadsheetUrl: "https://example.feishu.cn/sheets/sht_test",
    reportDate: "2026-06-22",
    preshipThresholdHours: 48,
  });

  assert.equal(result.spreadsheetUrl, "https://example.feishu.cn/sheets/sht_test");
  assert.equal(result.actionLog.entries, 2);
  assert.match(result.actionLogCsv, /OT1,2026-06-21/);
  assert.match(result.actionLogCsv, /OT1,2026-06-22/);

  const preshipWrite = client.calls.find((call) => call[0] === "writeSheetRange" && call[1].startsWith("pfx!A1:"));
  assert.ok(preshipWrite);
  assert.deepEqual(preshipWrite[2][0].slice(0, 5), [
    "WS#",
    "OT number",
    "Action taken?",
    "Action count",
    "Last action date",
  ]);
  assert.deepEqual(preshipWrite[2][1].slice(0, 5), [
    "WS-#33000",
    "OT1",
    "TRUE",
    2,
    "2026-06-22",
  ]);

  const logWrite = client.calls.find((call) => call[0] === "writeSheetRange" && call[1].startsWith("log!A1:"));
  assert.deepEqual(logWrite[2], [
    ["OT number", "Action date"],
    ["OT1", "2026-06-21"],
    ["OT1", "2026-06-22"],
  ]);
});

test("live sheet report recognizes existing tabs from array-shaped metadata", async () => {
  const client = fakeSheetClientWithMetadataShapes([sheetInfoArrayShape()]);

  await writeWatchtowerLiveSheetReport([row()], {
    client,
    spreadsheetToken: "sht_test",
    reportDate: "2026-06-22",
    preshipThresholdHours: 48,
  });

  const setupCalls = client.calls.filter((call) => call[0] === "batchUpdateSheets");
  assert.equal(
    setupCalls.some((call) => JSON.stringify(call[1]).includes("addSheet")),
    false,
  );
});

test("live sheet report recognizes existing tabs from deeply nested metadata", async () => {
  const client = fakeSheetClientWithMetadataShapes([{
    data: {
      spreadsheet: {
        spreadsheet: {
          token: "sht_test",
        },
      },
      unexpected: {
        nested: {
          values: [
            { sheet_id: "pfx", title: "preship FedEx" },
            { sheet_id: "plt", title: "preship LtL Other" },
            { sheet_id: "ifx", title: "In Transit FedEx" },
            { sheet_id: "ilt", title: "In Transit LtL Other" },
            { sheet_id: "log", title: "_Watchtower Actions" },
          ],
        },
      },
    },
  }]);

  await writeWatchtowerLiveSheetReport([row()], {
    client,
    spreadsheetToken: "sht_test",
    reportDate: "2026-06-22",
    preshipThresholdHours: 48,
  });

  const preshipWrite = client.calls.find((call) => call[0] === "writeSheetRange" && call[1].startsWith("pfx!A1:"));
  assert.ok(preshipWrite);
});

test("live sheet report can use configured tab IDs when metadata has no tabs", async () => {
  const client = fakeSheetClientWithMetadataShapes([{ data: { spreadsheet: { spreadsheet: { token: "sht_test" } } } }]);

  await writeWatchtowerLiveSheetReport([row()], {
    client,
    spreadsheetToken: "sht_test",
    sheetTabs: {
      "preship FedEx": "pfx",
      "preship LtL Other": "plt",
      "In Transit FedEx": "ifx",
      "In Transit LtL Other": "ilt",
      "_Watchtower Actions": "log",
    },
    reportDate: "2026-06-22",
    preshipThresholdHours: 48,
  });

  const preshipWrite = client.calls.find((call) => call[0] === "writeSheetRange" && call[1].startsWith("pfx!A1:"));
  assert.ok(preshipWrite);
  const setupCalls = client.calls.filter((call) => call[0] === "batchUpdateSheets");
  assert.equal(
    setupCalls.some((call) => JSON.stringify(call[1]).includes("addSheet")),
    false,
  );
});

test("live sheet report recovers when Feishu says a sheet title already exists", async () => {
  const emptyInfo = { data: { sheets: { sheets: [] } } };
  const client = fakeSheetClientWithMetadataShapes([
    emptyInfo,
    emptyInfo,
    sheetInfoArrayShape(),
  ]);
  client.batchUpdateSheets = async (_token, requests) => {
    client.calls.push(["batchUpdateSheets", requests]);
    if (JSON.stringify(requests).includes("addSheet")) {
      throw new Error("Feishu API request failed: sheetTitle already exist in snapshot");
    }
  };

  await writeWatchtowerLiveSheetReport([row()], {
    client,
    spreadsheetToken: "sht_test",
    reportDate: "2026-06-22",
    preshipThresholdHours: 48,
  });

  const preshipWrite = client.calls.find((call) => call[0] === "writeSheetRange" && call[1].startsWith("pfx!A1:"));
  assert.ok(preshipWrite);
});
