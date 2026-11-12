import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryKnownCombinationStore } from "@lantern/delineator";
import { historicalKnownCombinationsPath, planDv1Data } from "../src/dv1/plan.js";

test("DV1 produces a recommendation using the compiled Delineator package", async () => {
  const [order, inventory, { records }] = await Promise.all([
    new URL("./fixtures/dv1/order.json", import.meta.url),
    new URL("./fixtures/dv1/inventory.json", import.meta.url),
    historicalKnownCombinationsPath,
  ].map(async (path) => JSON.parse(await readFile(path, "utf8"))));

  const result = await planDv1Data({ order, inventory }, {
    knownCombinations: new InMemoryKnownCombinationStore(records),
  });

  assert.equal(result.plan.status, "ready");
  assert.deepEqual(result.plan.shipments.map((shipment) => ({
    name: shipment.fulfillmentName,
    warehouse: shipment.warehouseId,
    carton: shipment.containerSku,
    quantities: shipment.lines.map(({ sku, quantity }) => [sku, quantity]),
  })), [{
    name: "WS-#10001-b1",
    warehouse: "LA-SPI1",
    carton: "ABOX0007",
    quantities: [["AACC0019B", 2], ["AACC0073A", 1], ["AACC0036A", 1]],
  }]);
  assert.deepEqual(result.plan.ignoredLines.map(({ sku }) => sku), ["MERCH-NOTE-CARD"]);
});

test("Feishu round-trips a new geometry proof separately from the legacy claim", async () => {
  const { FeishuKnownCombinationSink } = await import("../src/dv1/knownSolutionArchive.js");
  const legacy = [
    "legacy", "key", "[]", "ABOX0001", '{"length":10,"width":10,"height":10,"unit":"mm"}',
    "LA-SPI1", "geometry_validated", "", "", "2026-11-04T00:00:00Z", "", 0, 1,
  ];
  const rows = [["record_id"], legacy];
  const sink = new FeishuKnownCombinationSink({
    readSheetRange: async () => ({ valueRange: { values: rows } }),
    appendSheetRows: async (_token, _range, appended) => { rows.push(...appended); },
  }, "test-sheet", "test-tab");
  const [record] = await sink.readAll();
  assert.equal(record.geometryProofVersion, undefined);
  await sink.append([{ ...record, geometryProofVersion: 2 }]);
  await sink.append([{ ...record, geometryProofVersion: 2 }]);
  assert.deepEqual((await sink.readAll()).map((fit) => fit.geometryProofVersion), [undefined, 2]);
});
