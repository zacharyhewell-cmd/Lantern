import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryKnownCombinationStore } from "@lantern/delineator";
import { planDv1Data } from "../src/dv1/plan.js";
import { Dv1SourceValidationError } from "../src/dv1/sourceValidation.js";
import { buildReferenceCatalog, buildSoloShippingCosts, readAllRows, refreshDv1SourceSnapshots, startDv1SourceRefreshScheduler } from "../src/dv1/sourceUpdater.js";

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

test("preserves the provisional AACC0099B alias during weekly catalog refresh", () => {
  const catalog = buildReferenceCatalog([
    ["No.", "Product Name", "SKU", "Inner", "Weight", "Master", "Master Weight", "Ignored"],
    [34, "Velotric Suspension Seatpost 2.0", "AACC0099A", "395*134*89", 1.165, "", "", "ignore"],
  ]);

  const alias = catalog.skus.find((sku) => sku.sku === "AACC0099B");
  assert.deepEqual(alias?.dimensions, { length: 395, width: 134, height: 89, unit: "mm" });
  assert.deepEqual(alias?.weight, { value: 2.568, unit: "lb" });
  assert.match(alias?.sourceNote || "", /dimensionally equivalent to AACC0099A/);
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

const catalogueSkus = [
  "AACC0019B", "AACC0073A", "AACC0186A-D", ...Array.from({ length: 7 }, (_, i) => `AA10${i}`),
];
const costSkus = catalogueSkus.filter((sku) => !sku.endsWith("-D"));

function skuRow(sku, dimensions = "1*2*3") {
  return sku.endsWith("-D")
    ? [1, "Bulk item", sku, "", "", dimensions]
    : [1, "Item", sku, dimensions];
}

async function refreshFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dv1-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalogBaselinePath = path.join(root, "reference-catalog.json");
  const costsBaselinePath = path.join(root, "solo-shipping-costs.json");
  const snapshotPath = path.join(root, "source-snapshot.json");
  const cartons = Array.from({ length: 7 }, (_, index) => ({
    sku: `ABOX000${index + 1}`, innerDimensions: { length: 10, width: 10, height: 10, unit: "mm" },
  }));
  await fs.writeFile(catalogBaselinePath, JSON.stringify({
    ...buildReferenceCatalog([[], ...catalogueSkus.map((sku) => skuRow(sku))]), cartons,
  }));
  await fs.writeFile(costsBaselinePath, JSON.stringify({ costs: costSkus.map((sku) => ({ sku })) }));
  const reads = [];
  const fixture = {
    catalogRows: catalogueSkus.map((sku) => skuRow(sku)),
    costSkus: [...costSkus],
    failCosts: false,
    snapshotPath,
    catalogBaselinePath,
    reads,
  };
  const feishuClient = {
    async readSheetRange(token, range) {
      reads.push([token, range]);
      if (token === "catalog") return { valueRange: { values: [[], ...fixture.catalogRows] } };
      if (fixture.failCosts) throw new Error("Feishu costs unavailable");
      return { valueRange: { values: [[], ...fixture.costSkus.map((sku, i) => [
        "", "", "", "", "", `T-${i}`, sku, "", "", "", "", "", 12,
      ])] } };
    },
  };
  fixture.refresh = (options) => refreshDv1SourceSnapshots({
    feishuClient,
    catalog: { spreadsheetToken: "catalog", sheetId: "tab", maxRows: 10_000 },
    fedex: { spreadsheetToken: "fedex", sheetId: "tab", maxRows: 10_000 },
    catalogBaselinePath,
    costsBaselinePath,
    snapshotPath,
    now: () => new Date("2026-11-04T12:00:00Z"),
    ...options,
  });
  return fixture;
}

test("publishes a small source change atomically and plans using the refreshed pair", async (t) => {
  const fixture = await refreshFixture(t);
  fixture.catalogRows[0] = skuRow("AACC0019B", "2×3×4 mmmm");
  fixture.catalogRows.push(skuRow("AANEW"));
  fixture.catalogRows.push(skuRow("AA111", ""));
  const result = await fixture.refresh();

  const published = await fs.readFile(fixture.snapshotPath, "utf8");
  const { referenceCatalog: catalog, soloShippingCosts: costs, generatedAt } = JSON.parse(published);
  assert.equal(result.baselineKind, "checked-in");
  assert.equal(result.catalog.previousCount, 10);
  assert.equal(result.catalog.candidateCount, 11);
  assert.deepEqual(result.catalog.added, ["AANEW"]);
  assert.deepEqual(result.catalog.changedDimensions, ["AACC0019B"]);
  assert.equal(result.blankDimensionRows, 1);
  assert.equal(catalog.cartons.length, 7);
  assert.equal(costs.costs.length, 9);
  assert.equal(catalog.generatedFrom.fetchedAt, generatedAt);
  assert.deepEqual(fixture.reads, [["catalog", "tab!A1:H10000"], ["fedex", "tab!A1:M10000"]]);

  fixture.failCosts = true;
  await assert.rejects(fixture.refresh(), /Feishu costs unavailable/);
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), published);
  const warehouseId = "LA-SPI1";
  const { plan, order } = await planDv1Data({
    order: {
      orderId: "order", orderNumber: "WS-#10001", warehouseId,
      destination: { postalCode: "50309", countryCode: "US" },
      lines: [{ id: "line", sku: "AACC0019B", quantity: 1 }],
    },
    inventory: { warehouseId, items: [{ sku: "AACC0019B", available: 1 }] },
  }, { sourceSnapshotPath: fixture.snapshotPath, knownCombinations: new InMemoryKnownCombinationStore() });
  assert.equal(plan.status, "ready");
  assert.deepEqual(order.lines[0].dimensions, { length: 2, width: 3, height: 4, unit: "mm" });
  assert.match(plan.shipments[0].reasons.join(" "), /Historical solo median for AACC0019B is \$12\.00/);
});

test("invalid dimensions, missing SKUs, and conflicting duplicates leave the active bytes unchanged", async (t) => {
  const fixture = await refreshFixture(t);
  await fixture.refresh();
  const published = await fs.readFile(fixture.snapshotPath, "utf8");
  const original = [...fixture.catalogRows];
  for (const invalid of ["-20×30×40 mm", "10×20×30 cm", "0×20×30 mm"]) {
    fixture.catalogRows[0] = skuRow("AACC0019B", invalid);
    await assert.rejects(fixture.refresh(), (error) => {
      assert.ok(error instanceof Dv1SourceValidationError);
      assert.match(error.rules.join(" "), /invalid dimensions or unsupported units/);
      assert.deepEqual(error.summary.malformedSkus, ["AACC0019B"]);
      return true;
    });
    assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), published);
  }
  fixture.catalogRows = [...original, skuRow("", "1×2×3")];
  await assert.rejects(fixture.refresh(), { name: "Dv1SourceValidationError" });
  fixture.catalogRows = [...original, skuRow("AACC0019B", "7×8×9")];
  await assert.rejects(fixture.refresh(), (error) => {
    assert.ok(error instanceof Dv1SourceValidationError);
    assert.deepEqual(error.summary.conflictingSkus, ["AACC0019B"]);
    return true;
  });
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), published);
});

test("explicit SKU rows override expanded definitions and identical duplicates are accepted", async (t) => {
  const fixture = await refreshFixture(t);
  fixture.catalogRows.push(skuRow("AACC0019B/20B", "5×6×7"));
  fixture.catalogRows.push(skuRow("AACC0019B"));
  const summary = await fixture.refresh();
  assert.deepEqual(summary.conflictingSkus, []);
  const { referenceCatalog } = JSON.parse(await fs.readFile(fixture.snapshotPath, "utf8"));
  assert.deepEqual(referenceCatalog.skus.find(({ sku }) => sku === "AACC0019B").dimensions,
    { length: 1, width: 2, height: 3, unit: "mm" });
});

test("first refresh measures retained SKUs in both checked-in baselines even when counts stay the same", async (t) => {
  const fixture = await refreshFixture(t);
  fixture.catalogRows.splice(-3, 3, ...["AA200", "AA201", "AA202"].map((sku) => skuRow(sku)));
  fixture.costSkus.splice(-3, 3, "AA200", "AA201", "AA202");
  await assert.rejects(fixture.refresh(), (error) => {
    assert.ok(error instanceof Dv1SourceValidationError);
    assert.equal(error.summary.baselineKind, "checked-in");
    assert.equal(error.summary.catalog.previousCount, 10);
    assert.equal(error.summary.catalog.candidateCount, 10);
    assert.equal(error.summary.catalog.retainedCount, 7);
    assert.equal(error.summary.costs.previousCount, 9);
    assert.equal(error.summary.costs.retainedCount, 6);
    assert.match(error.rules.join(" "), /catalog retained 7.*costs retained 6/);
    return true;
  });
  await assert.rejects(fs.stat(fixture.snapshotPath), { code: "ENOENT" });
  const accepted = await fixture.refresh({ minCoverage: 0.65 });
  assert.equal(accepted.catalog.retainedCount, 7);
  assert.equal((await fixture.refresh()).baselineKind, "active");
});

test("refresh checks representative SKUs and all seven carton definitions", async (t) => {
  const fixture = await refreshFixture(t);
  fixture.catalogRows.shift();
  const baseline = JSON.parse(await fs.readFile(fixture.catalogBaselinePath, "utf8"));
  baseline.cartons.pop();
  await fs.writeFile(fixture.catalogBaselinePath, JSON.stringify(baseline));
  await assert.rejects(fixture.refresh(), (error) => {
    assert.ok(error instanceof Dv1SourceValidationError);
    assert.match(error.rules.join(" "), /seven checked-in carton definitions/);
    assert.match(error.rules.join(" "), /missing representative SKUs AACC0019B/);
    return true;
  });
  await assert.rejects(fs.stat(fixture.snapshotPath), { code: "ENOENT" });
});

test("scheduler sends one sanitized rejection alert, survives a send failure, and can publish later", async (t) => {
  const fixture = await refreshFixture(t);
  await fixture.refresh();
  const published = await fs.readFile(fixture.snapshotPath, "utf8");
  fixture.catalogRows[0] = skuRow("AACC0019B", "sensitive invalid text");
  const messages = [];
  const logs = [];
  const scheduler = startDv1SourceRefreshScheduler({
    enabled: true, initialDelayMs: 60_000, intervalMs: 60_000, refresh: fixture.refresh,
    sendRejectionAlert: async (message, options) => {
      messages.push({ message, ...options });
      if (messages.length === 2) throw new Error("message unavailable");
    },
    logger: { error: (message) => logs.push(message) },
  });
  t.after(() => scheduler.stop());
  await scheduler.run();
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /^DV1 source refresh rejected/);
  assert.match(messages[0].message, /2026-11-04T12:00:00.000Z/);
  assert.match(messages[0].message, /10 previous, 9 candidate.*AACC0019B/);
  assert.match(messages[0].message, /Malformed rows: 1 catalog/);
  assert.match(messages[0].message, /retained the previous snapshot/);
  assert.doesNotMatch(messages[0].message, /sensitive invalid text/);
  assert.ok(messages[0].idempotencyKey);
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), published);

  await scheduler.run();
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].idempotencyKey, messages[1].idempotencyKey);
  assert.ok(logs.some((message) => message.includes("alert failed: message unavailable")));
  assert.equal(await fs.readFile(fixture.snapshotPath, "utf8"), published);

  fixture.failCosts = true;
  await scheduler.run();
  assert.equal(messages.length, 2);
  fixture.failCosts = false;
  fixture.catalogRows[0] = skuRow("AACC0019B", "4×5×6");
  await scheduler.run();
  assert.equal(messages.length, 2);
  assert.notEqual(await fs.readFile(fixture.snapshotPath, "utf8"), published);
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
