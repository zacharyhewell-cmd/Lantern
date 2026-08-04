import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWtfSheetReply,
  extractWtfOrderIdentifier,
  findWtfSheetRows,
  formatWtfSheetReply,
  isWtfSheetLookupTrigger,
} from "../src/lantern/wtfSheetLookup.js";

const sampleValues = [
  [
    "Order SKU",
    "Product Category",
    "Order Date",
    "Order Number",
    "Platform Order ID",
    "Store",
    "Sales Rep",
    "Customer / Buyer",
    "Company Name",
    "Warehouse",
    "Order State",
    "Order Status",
    "Product Title",
    "Order Qty",
    "SKU Order Rank",
    "Cumulative Qty by SKU",
    "Covered by Next Inbound",
    "Dashboard Product",
    "Product Status",
    "Inventory After Pending",
    "Next Inbound Date",
  ],
  ["AACC0028A", "", "", "WS-#37974", "", "", "", "", "", "", "", "", "Velotric Seat Pad", "", "", "", "Yes", "", "", "", "08/17/2026"],
  ["VB010001B", "", "", "WS-#37974", "", "", "", "", "", "", "", "", "Bike", "", "", "", "No", "", "", "", ""],
  ["AACC9999A", "", "", "WS-#11111", "", "", "", "", "", "", "", "", "Other", "", "", "", "No", "", "", "", ""],
];

test("detects WTF sheet lookup trigger with WS order number", () => {
  assert.equal(isWtfSheetLookupTrigger("WTF WS-#37974"), true);
  assert.equal(isWtfSheetLookupTrigger("wtf ws-37974"), true);
  assert.equal(isWtfSheetLookupTrigger("WTF 37974"), true);
  assert.equal(isWtfSheetLookupTrigger("Lantern WS-#37974"), false);
  assert.deepEqual(extractWtfOrderIdentifier("WTF WS-#37974"), {
    raw: "WTF WS-#37974",
    digits: "37974",
    canonical: "WS-#37974",
  });
});

test("finds rows by order number in column D", () => {
  const rows = findWtfSheetRows(sampleValues, { canonical: "WS-#37974" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], "AACC0028A");
  assert.equal(rows[1][0], "VB010001B");
});

test("formats only columns A, M, Q, and U", () => {
  const rows = findWtfSheetRows(sampleValues, { canonical: "WS-#37974" });
  const reply = formatWtfSheetReply({
    orderIdentifier: { canonical: "WS-#37974" },
    values: sampleValues,
    rows,
  });

  assert.match(reply, /WS-#37974: 2 matching rows/);
  assert.match(reply, /Order SKU: AACC0028A/);
  assert.match(reply, /Product Title: Velotric Seat Pad/);
  assert.match(reply, /Covered by Next Inbound: Yes/);
  assert.match(reply, /Next Inbound Date: 08\/17\/2026/);
  assert.match(reply, /Covered by Next Inbound: No/);
  assert.match(reply, /\nItem is at least 2 inbounds away/);
  assert.doesNotMatch(reply, /Next Inbound Date: Item is at least 2 inbounds away/);
  assert.doesNotMatch(reply, /Order Number:/);
  assert.doesNotMatch(reply, /Warehouse:/);
});

test("builds reply from Feishu sheet client", async () => {
  const reads = [];
  const reply = await buildWtfSheetReply("WTF WS-#37974", {
    config: {
      sheetToken: "sht_test",
      sheetId: "sheet_test",
      maxRows: 100,
    },
    feishuClient: {
      async readSheetRange(...args) {
        reads.push(args);
        return { data: { valueRange: { values: sampleValues } } };
      },
    },
  });

  assert.deepEqual(reads, [["sht_test", "sheet_test!A1:U100"]]);
  assert.match(reply, /Order SKU: AACC0028A/);
});

test("prefers resolving WTF sheet tab by title", async () => {
  const reads = [];
  const reply = await buildWtfSheetReply("WTF WS-#37974", {
    config: {
      sheetToken: "sht_test",
      sheetId: "stale_sheet",
      sheetTitle: "OOS Pending Orders All Products",
      maxRows: 100,
    },
    feishuClient: {
      async readSheetRange(_token, range) {
        reads.push(range);
        if (range.startsWith("stale_sheet!")) {
          throw new Error("Feishu API request failed: not found sheetId");
        }
        return { data: { valueRange: { values: sampleValues } } };
      },
      async getSpreadsheet() {
        return {
          data: {
            sheets: {
              sheets: [
                { sheet_id: "fresh_sheet", title: "OOS Pending Orders All Products" },
              ],
            },
          },
        };
      },
    },
  });

  assert.deepEqual(reads, ["fresh_sheet!A1:U100"]);
  assert.match(reply, /Order SKU: AACC0028A/);
});

test("falls back to configured WTF sheet ID when title is unavailable", async () => {
  const reads = [];
  const reply = await buildWtfSheetReply("WTF WS-#37974", {
    config: {
      sheetToken: "sht_test",
      sheetId: "configured_sheet",
      sheetTitle: "Missing Title",
      maxRows: 100,
    },
    feishuClient: {
      async readSheetRange(_token, range) {
        reads.push(range);
        return { data: { valueRange: { values: sampleValues } } };
      },
      async getSpreadsheet() {
        return {
          data: {
            sheets: {
              sheets: [
                { sheet_id: "other_sheet", title: "Other Title" },
              ],
            },
          },
        };
      },
    },
  });

  assert.deepEqual(reads, ["configured_sheet!A1:U100"]);
  assert.match(reply, /Order SKU: AACC0028A/);
});
