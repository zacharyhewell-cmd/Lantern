import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildReferenceCatalog, buildSoloShippingCosts, readAllRows, refreshDv1SourceSnapshots } from "../src/dv1/sourceUpdater.js";

test("builds the SKU catalog from the live sheet shape and preserves bulk-carton columns", () => {
  const catalog = buildReferenceCatalog([
    ["No.", "Product Name", "SKU", "Inner", "Weight", "Master", "Master Weight", "Ignored"],
    [1, "Product", "AACC0001A", "10*20*30", 1, "", "", "ignore"],
    [2, "", "AACC0001A-D", "", "", "100*200*300", 2, "ignore"],
  ], { spreadsheetToken: "catalog", sheetId: "tab", fetchedAt: "now" });

  assert.equal(catalog.skus.length, 2);
  assert.deepEqual(catalog.skus[1].dimensions, { length: 100, width: 200, height: 300, unit: "mm" });
  assert.equal(catalog.skus[1].name, "Product");
  assert.deepEqual(catalog.generatedFrom.excludedColumns, ["H"]);
});

test("builds solo cost baselines from one paid AA tracking row", () => {
  const costs = buildSoloShippingCosts([
    Array.from({ length: 13 }, (_, index) => `H${index}`),
    ["", "", "", "", "", "TRACK-1", "AACC0001A", "", "", "", "", "", "19.75"],
    ["", "", "", "", "", "TRACK-2", "VBIKE", "", "", "", "", "", "80"],
  ], { spreadsheetToken: "fedex", sheetId: "tab", generatedAt: "today" });

  assert.equal(costs.costs.length, 1);
  assert.equal(costs.costs[0].sku, "AACC0001A");
  assert.equal(costs.costs[0].medianCostUsd, 19.75);
});

test("refreshes both snapshots atomically and keeps existing carton definitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dv1-refresh-"));
  const catalogPath = path.join(root, "reference-catalog.json");
  const costsPath = path.join(root, "solo-shipping-costs.json");
  await fs.writeFile(catalogPath, JSON.stringify({ cartons: [{ sku: "ABOX0001" }] }));
  const reads = [];
  const client = {
    async readSheetRange(token, range) {
      reads.push([token, range]);
      if (token === "catalog") {
        return { data: { valueRange: { values: [["No.", "Name", "SKU", "Dims", "Weight"], [1, "Item", "AA1", "1*2*3", 1]] } } };
      }
      return { data: { valueRange: { values: [["h"], ["", "", "", "", "", "T", "AA1", "", "", "", "", "", "12"]] } } };
    },
  };
  const result = await refreshDv1SourceSnapshots({
    feishuClient: client,
    catalog: { spreadsheetToken: "catalog", sheetId: "tab", columns: "A:H", maxRows: 10_000 },
    fedex: { spreadsheetToken: "fedex", sheetId: "tab", columns: "A:M", maxRows: 10_000 },
    catalogOutputPath: catalogPath,
    soloShippingOutputPath: costsPath,
    now: () => new Date("2026-11-04T12:00:00Z"),
  });

  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const costs = JSON.parse(await fs.readFile(costsPath, "utf8"));
  assert.equal(result.catalogSkus, 1);
  assert.equal(result.soloSkuBaselines, 1);
  assert.equal(catalog.cartons[0].sku, "ABOX0001");
  assert.equal(costs.costs[0].sku, "AA1");
  assert.equal(reads.length, 2);
});

test("reads multiple pages without duplicating headers", async () => {
  const calls = [];
  const rows = await readAllRows({
    async readSheetRange(_token, range) {
      calls.push(range);
      const start = Number(range.match(/!A(\d+):/)[1]);
      return { data: { valueRange: { values: start === 1
        ? [["header"], ...Array.from({ length: 9_999 }, (_, index) => [`row-${index}`])]
        : [["second"]] } } };
    },
  }, "sheet", "tab", "A:B", 20_000);

  assert.equal(rows[0][0], "header");
  assert.equal(rows.at(-1)[0], "second");
  assert.equal(rows.length, 10_001);
  assert.deepEqual(calls, ["tab!A1:B10000", "tab!A10001:B20000"]);
});
