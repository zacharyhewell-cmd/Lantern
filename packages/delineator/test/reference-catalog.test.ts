import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSUMED_AVAILABLE_QUANTITY,
  createAssumedAvailableInventory
} from "../src/domain/assumed-inventory.js";
import {
  expandCompactSku,
  expandCompactSkuReference,
  hydrateCartonsFromReferenceCatalog
} from "../src/domain/reference-catalog.js";
import { soloShippingCostLookup } from "../src/domain/solo-shipping-costs.js";
import type { InventoryItem, ReferenceCatalog } from "../src/domain/types.js";

const catalog = JSON.parse(readFileSync("../../src/dv1/data/reference-catalog.json", "utf8")) as ReferenceCatalog;

test("contains the confirmed Velotric carton listings", () => {
  assert.deepEqual(
    catalog.cartons.map((carton) => ({
      sku: carton.sku,
      name: carton.name,
      dimensions: carton.innerDimensions
    })),
    [
      {
        sku: "ABOX0001",
        name: "Velotric Box S",
        dimensions: { length: 430, width: 205, height: 260, unit: "mm" }
      },
      {
        sku: "ABOX0002",
        name: "Velotric Box M",
        dimensions: { length: 500, width: 360, height: 310, unit: "mm" }
      },
      {
        sku: "ABOX0003",
        name: "Velotric Box L",
        dimensions: { length: 500, width: 400, height: 540, unit: "mm" }
      },
      {
        sku: "ABOX0004",
        name: "Velotric Box F",
        dimensions: { length: 865, width: 500, height: 305, unit: "mm" }
      },
      {
        sku: "ABOX0005",
        name: "Velotric Box A",
        dimensions: { length: 325, width: 360, height: 170, unit: "mm" }
      },
      {
        sku: "ABOX0006",
        name: "Velotric Box B",
        dimensions: { length: 485, width: 400, height: 380, unit: "mm" }
      },
      {
        sku: "ABOX0007",
        name: "Velotric Box C",
        dimensions: { length: 355, width: 190, height: 190, unit: "mm" }
      }
    ]
  );
});

test("hydrates ABOX inventory items from the reference catalog", () => {
  const inventory: InventoryItem[] = [{ sku: "ABOX0002", available: 4 }];
  const hydrated = hydrateCartonsFromReferenceCatalog(inventory, catalog);

  assert.deepEqual(hydrated[0]?.container?.innerDimensions, {
    length: 500,
    width: 360,
    height: 310,
    unit: "mm"
  });
});

test("creates assumed-available inventory for catalog-based tests", () => {
  const inventory = createAssumedAvailableInventory(catalog, "test-warehouse");

  assert.equal(inventory.warehouseId, "test-warehouse");
  assert.equal(inventory.items.length, catalog.skus.length + catalog.cartons.length);
  assert.equal(inventory.items.every((item) => item.available === ASSUMED_AVAILABLE_QUANTITY), true);
  assert.equal(inventory.items.some((item) => item.sku === "AACC0073A"), true);
  assert.deepEqual(inventory.items.find((item) => item.sku === "ABOX0007")?.container?.innerDimensions, {
    length: 355,
    width: 190,
    height: 190,
    unit: "mm"
  });
});

test("creates lookup for historical solo shipping costs", () => {
  const lookup = soloShippingCostLookup({
    currency: "USD",
    costs: [
      {
        sku: "AACC0136A",
        shipmentCount: 1897,
        averageCostUsd: 14.4,
        medianCostUsd: 11.79
      }
    ]
  });

  assert.equal(lookup.get("AACC0136A")?.medianCostUsd, 11.79);
});

test("contains imported AA SKU dimensions from the accessories package sheet", () => {
  assert.equal(catalog.skus.length, 113);
  assert.deepEqual(catalog.generatedFrom?.sourceColumns, ["A", "B", "C", "D", "E", "F", "G"]);
  assert.deepEqual(catalog.generatedFrom?.excludedColumns, ["H"]);

  const mirror = catalog.skus.find((sku) => sku.sku === "AACC0019B");

  assert.equal(mirror?.name, "Velotric Mirror");
  assert.deepEqual(mirror?.dimensions, { length: 170, width: 85, height: 45, unit: "mm" });
  assert.deepEqual(mirror?.weight, { value: 0.364, unit: "lb" });
  assert.match(mirror?.sourceNote ?? "", /columns A-G/);

  const suspensionSeatpostAlias = catalog.skus.find((sku) => sku.sku === "AACC0099B");
  assert.deepEqual(suspensionSeatpostAlias?.dimensions, {
    length: 395,
    width: 134,
    height: 89,
    unit: "mm"
  });
  assert.deepEqual(suspensionSeatpostAlias?.weight, { value: 2.568, unit: "lb" });
  assert.match(suspensionSeatpostAlias?.sourceNote ?? "", /assumed dimensionally equivalent to AACC0099A/);

  const bulkMirror = catalog.skus.find((sku) => sku.sku === "AACC0186A-D");
  assert.deepEqual(bulkMirror?.dimensions, { length: 300, width: 320, height: 300, unit: "mm" });
  assert.deepEqual(bulkMirror?.weight, { value: 10.251, unit: "lb" });
  assert.match(bulkMirror?.sourceNote ?? "", /dimensions from column F/);
  assert.equal(catalog.skus.some((sku) => sku.sku === "AACC0177A-D"), false);
});

test("imports -D bulk-carton SKUs from master-carton columns F-G", () => {
  const bySku = new Map(catalog.skus.map((sku) => [sku.sku, sku]));

  assert.deepEqual(bySku.get("AACC0183A-D")?.dimensions, {
    length: 430,
    width: 460,
    height: 245,
    unit: "mm"
  });
  assert.match(bySku.get("AACC0183A-D")?.name ?? "", /^Velotric Bike Phone Mount/);
  assert.deepEqual(bySku.get("AACC0189A-D")?.dimensions, {
    length: 385,
    width: 205,
    height: 360,
    unit: "mm"
  });
  assert.deepEqual(bySku.get("AACC0179A-D")?.dimensions, {
    length: 520,
    width: 455,
    height: 360,
    unit: "mm"
  });
  assert.equal(bySku.has("AACCO167A-D"), false);
  assert.deepEqual(bySku.get("AACC0167A-D")?.dimensions, {
    length: 390,
    width: 220,
    height: 165,
    unit: "mm"
  });
  assert.match(bySku.get("AACC0167A-D")?.sourceNote ?? "", /Corrected source SKU typo AACCO167A-D/);
  assert.equal(bySku.has("AACC0177A-D"), false);
});

test("expands compact AA SKU ranges and lists", () => {
  assert.deepEqual(expandCompactSku("AACC0011B-14B"), [
    "AACC0011B",
    "AACC0012B",
    "AACC0013B",
    "AACC0014B"
  ]);
  assert.deepEqual(expandCompactSku("AACC0084A-087A"), [
    "AACC0084A",
    "AACC0085A",
    "AACC0086A",
    "AACC0087A"
  ]);
  assert.deepEqual(expandCompactSku("AACC0124A/124B"), ["AACC0124A", "AACC0124B"]);
  assert.deepEqual(expandCompactSku("AACC0183A-D"), ["AACC0183A-D"]);
});

test("catalog contains expanded individual SKU entries instead of compact source cells", () => {
  const bySku = new Map(catalog.skus.map((sku) => [sku.sku, sku]));

  assert.equal(bySku.has("AACC0011B-14B"), false);
  assert.equal(bySku.has("AACC0095A-96A"), false);
  assert.equal(bySku.has("AACC0084A-087A"), false);
  assert.equal(bySku.has("AACC0124A/124B"), false);
  assert.equal(bySku.has("AACC0134A/0138A/0139A"), false);

  for (const sku of ["AACC0011B", "AACC0012B", "AACC0013B", "AACC0014B"]) {
    assert.deepEqual(bySku.get(sku)?.dimensions, { length: 725, width: 310, height: 80, unit: "mm" });
  }

  assert.match(bySku.get("AACC0183A-D")?.name ?? "", /^Velotric Bike Phone Mount/);
});

test("expanded references copy source fields onto each SKU", () => {
  const expanded = expandCompactSkuReference({
    sku: "AACC0011B-14B",
    name: "Thunder 1 Fender Pack M",
    dimensions: { length: 725, width: 310, height: 80, unit: "mm" },
    packGroup: "standard",
    sourceNote: "Imported test source."
  });

  assert.deepEqual(
    expanded.map((sku) => sku.sku),
    ["AACC0011B", "AACC0012B", "AACC0013B", "AACC0014B"]
  );
  assert.deepEqual(expanded[1]?.dimensions, { length: 725, width: 310, height: 80, unit: "mm" });
  assert.match(expanded[1]?.sourceNote ?? "", /Expanded from source SKU AACC0011B-14B/);
});
