import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryKnownCombinationStore,
  JsonFileKnownCombinationStore,
  createKnownCombinationRecord,
  knownCombinationKey,
  type KnownCombinationRecord
} from "../src/planner/known-combinations.js";
import { planShipments } from "../src/planner/shipment-planner.js";
import type { Dimensions, InventorySnapshot, NormalizedOrder } from "../src/domain/types.js";
import { DEFAULT_FEDEX_GROUND_RATE_CONFIG } from "../src/domain/shipping-rates.js";

const baseOrder: NormalizedOrder = {
  orderId: "gid://shopify/Order/1001",
  orderNumber: "WS-#10001",
  warehouseId: "reno-main",
  lines: [
    {
      id: "line-1",
      sku: "AA-SMALL-A",
      quantity: 2,
      dimensions: { length: 6, width: 4, height: 2, unit: "in" },
      weight: { value: 1, unit: "lb" },
      packGroup: "standard"
    },
    {
      id: "line-2",
      sku: "AA-SMALL-B",
      quantity: 1,
      dimensions: { length: 5, width: 5, height: 3, unit: "in" },
      weight: { value: 1, unit: "lb" },
      packGroup: "standard"
    }
  ]
};

const baseInventory: InventorySnapshot = {
  warehouseId: "reno-main",
  items: [
    { sku: "AA-SMALL-A", available: 10 },
    { sku: "AA-SMALL-B", available: 10 },
    {
      sku: "ABOX-MEDIUM",
      available: 2,
      container: {
        innerDimensions: { length: 12, width: 10, height: 8, unit: "in" },
        maxWeight: { value: 20, unit: "lb" }
      }
    }
  ]
};

test("consolidates compatible available lines into the smallest passing container", () => {
  const plan = planShipments(baseOrder, baseInventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.fulfillmentName, "WS-#10001-b1");
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-MEDIUM");
  assert.deepEqual(
    plan.shipments[0]?.lines.map((line) => line.sku),
    ["AA-SMALL-A", "AA-SMALL-B"]
  );
});

test("ships a single eligible item without assigning a carton", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [
      {
        id: "line-1",
        sku: "AA-SOLO-A",
        quantity: 1,
        dimensions: { length: 6, width: 4, height: 2, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-SOLO-A", available: 1 },
      {
        sku: "ABOX-SOLO-FIT",
        available: 1,
        container: {
          innerDimensions: { length: 6, width: 4, height: 2, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.containerSku, null);
  assert.deepEqual(plan.shipments[0]?.lines, [{ orderLineId: "line-1", sku: "AA-SOLO-A", quantity: 1 }]);
});

test("marks order for review when Surpath inventory is insufficient", () => {
  const inventory: InventorySnapshot = {
    ...baseInventory,
    items: baseInventory.items.map((item) => (item.sku === "AA-SMALL-A" ? { ...item, available: 1 } : item))
  };

  const plan = planShipments(baseOrder, inventory);

  assert.equal(plan.status, "needs_review");
  assert.equal(plan.exceptions[0]?.code, "INSUFFICIENT_ITEM_INVENTORY");
  assert.equal(plan.shipments.length, 1);
  assert.deepEqual(plan.shipments[0]?.lines, [{ orderLineId: "line-2", sku: "AA-SMALL-B", quantity: 1 }]);
});

test("ignores non-AA SKUs for Delineator planning", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [...baseOrder.lines, { id: "line-3", sku: "MERCH-NOTE-CARD", quantity: 1 }]
  };

  const plan = planShipments(order, baseInventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.deepEqual(plan.ignoredLines, [{ orderLineId: "line-3", sku: "MERCH-NOTE-CARD", quantity: 1 }]);
});

test("marks AA lines for review when reference dimensions are missing", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [{ id: "line-3", sku: "AA-UNKNOWN", quantity: 1 }]
  };
  const inventory: InventorySnapshot = {
    ...baseInventory,
    items: [{ sku: "AA-UNKNOWN", available: 1 }, ...baseInventory.items]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "needs_review");
  assert.equal(plan.exceptions[0]?.code, "MISSING_REFERENCE_DATA");
  assert.equal(plan.shipments.length, 0);
});

test("requires operator direction when an AA SKU is absent from the catalog snapshot", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [{ id: "line-3", sku: "AA-NEW-SKU", quantity: 1, dimensions: { length: 4, width: 4, height: 4, unit: "in" } }]
  };
  const inventory: InventorySnapshot = {
    ...baseInventory,
    items: [{ sku: "AA-NEW-SKU", available: 1 }, ...baseInventory.items]
  };

  const plan = planShipments(order, inventory, { catalogSkus: new Set(["AA-SMALL-A"]) });

  assert.equal(plan.status, "needs_review");
  assert.equal(plan.exceptions[0]?.code, "MISSING_REFERENCE_DATA");
  assert.match(plan.exceptions[0]?.message ?? "", /Operator direction is required/);
  assert.equal(plan.shipments.length, 0);
});

test("marks order for review when AA SKU and carton dimensions use different units", () => {
  const inventory: InventorySnapshot = {
    ...baseInventory,
    items: baseInventory.items.map((item) =>
      item.sku === "ABOX-MEDIUM" && item.container
        ? {
            ...item,
            container: {
              ...item.container,
              innerDimensions: { length: 300, width: 250, height: 200, unit: "mm" }
            }
          }
        : item
    )
  };

  const plan = planShipments(baseOrder, inventory);

  assert.equal(plan.status, "needs_review");
  assert.equal(plan.exceptions[0]?.code, "UNIT_MISMATCH");
});

test("ships items by themselves when no carton can consolidate them", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [
      {
        id: "line-1",
        sku: "AA-LONG-A",
        quantity: 2,
        dimensions: { length: 7, width: 4, height: 1.1, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-LONG-A", available: 2 },
      {
        sku: "ABOX-SKINNY",
        available: 1,
        container: {
          innerDimensions: { length: 8, width: 4, height: 2, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.exceptions, []);
  assert.equal(plan.shipments.length, 2);
  assert.deepEqual(plan.shipments.map((shipment) => shipment.containerSku), [null, null]);
  assert.deepEqual(
    plan.shipments.map((shipment) => shipment.lines),
    [
      [{ orderLineId: "line-1", sku: "AA-LONG-A", quantity: 1 }],
      [{ orderLineId: "line-1", sku: "AA-LONG-A", quantity: 1 }]
    ]
  );
});

test("uses a carton when multiple items can consolidate", () => {
  const order: NormalizedOrder = {
    orderId: "gid://shopify/Order/1002",
    orderNumber: "WS-#10002",
    warehouseId: "reno-main",
    lines: [
      {
        id: "line-1",
        sku: "AA-CUBE-A",
        quantity: 1,
        dimensions: { length: 4, width: 4, height: 4, unit: "in" }
      },
      {
        id: "line-2",
        sku: "AA-CUBE-B",
        quantity: 1,
        dimensions: { length: 1, width: 1, height: 1, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-CUBE-A", available: 1 },
      { sku: "AA-CUBE-B", available: 1 },
      {
        sku: "ABOX-LARGE-ROOMY",
        available: 1,
        container: {
          innerDimensions: { length: 10, width: 10, height: 10, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-A-EXACT",
        available: 1,
        container: {
          innerDimensions: { length: 4, width: 4, height: 4, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-B-EXACT",
        available: 1,
        container: {
          innerDimensions: { length: 1, width: 1, height: 1, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-LARGE-ROOMY");
  assert.deepEqual(
    plan.shipments[0]?.lines.map((line) => line.sku),
    ["AA-CUBE-A", "AA-CUBE-B"]
  );
});

test("keeps duplicate units together when they can consolidate into a carton", () => {
  const order: NormalizedOrder = {
    orderId: "gid://shopify/Order/1003",
    orderNumber: "WS-#10003",
    warehouseId: "reno-main",
    lines: [
      {
        id: "line-1",
        sku: "AA-UNIT-A",
        quantity: 2,
        dimensions: { length: 5, width: 5, height: 5, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-UNIT-A", available: 2 },
      {
        sku: "ABOX-TWO-ROOMY",
        available: 1,
        container: {
          innerDimensions: { length: 10, width: 10, height: 10, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-ONE-EXACT",
        available: 2,
        container: {
          innerDimensions: { length: 5, width: 5, height: 5, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-TWO-ROOMY");
  assert.deepEqual(plan.shipments[0]?.lines, [{ orderLineId: "line-1", sku: "AA-UNIT-A", quantity: 2 }]);
});

test("uses conservative solo fallback when historical costs are unavailable", () => {
  const order: NormalizedOrder = {
    orderId: "gid://shopify/Order/1004",
    orderNumber: "WS-#10004",
    warehouseId: "reno-main",
    lines: [
      {
        id: "line-1",
        sku: "AA-LARGE-A",
        quantity: 1,
        dimensions: { length: 840, width: 427, height: 75, unit: "mm" }
      },
      {
        id: "line-2",
        sku: "AA-RACK-B",
        quantity: 2,
        dimensions: { length: 455, width: 370, height: 155, unit: "mm" }
      },
      {
        id: "line-3",
        sku: "AA-POST-C",
        quantity: 2,
        dimensions: { length: 395, width: 134, height: 89, unit: "mm" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-LARGE-A", available: 1 },
      { sku: "AA-RACK-B", available: 2 },
      { sku: "AA-POST-C", available: 2 },
      {
        sku: "ABOX0001",
        available: 999,
        container: {
          innerDimensions: { length: 430, width: 205, height: 260, unit: "mm" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX0003",
        available: 999,
        container: {
          innerDimensions: { length: 500, width: 400, height: 540, unit: "mm" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX0004",
        available: 999,
        container: {
          innerDimensions: { length: 865, width: 500, height: 305, unit: "mm" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX0006",
        available: 999,
        container: {
          innerDimensions: { length: 485, width: 400, height: 380, unit: "mm" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 5);
  assert.deepEqual(plan.shipments.map((shipment) => shipment.containerSku), [null, null, null, null, null]);
});

test("uses historical solo cost baselines when ranking solo shipment options", () => {
  const order: NormalizedOrder = {
    orderId: "gid://shopify/Order/1005",
    orderNumber: "WS-#10005",
    warehouseId: "reno-main",
    lines: [
      {
        id: "line-1",
        sku: "AA-LARGE-SOLO",
        quantity: 1,
        dimensions: { length: 32, width: 16, height: 4, unit: "in" }
      },
      {
        id: "line-2",
        sku: "AA-MEDIUM-A",
        quantity: 2,
        dimensions: { length: 18, width: 14, height: 6, unit: "in" }
      },
      {
        id: "line-3",
        sku: "AA-SMALL-B",
        quantity: 2,
        dimensions: { length: 15, width: 5, height: 4, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-LARGE-SOLO", available: 1 },
      { sku: "AA-MEDIUM-A", available: 2 },
      { sku: "AA-SMALL-B", available: 2 },
      {
        sku: "ABOX-LARGE-MIXED",
        available: 999,
        container: {
          innerDimensions: { length: 34, width: 20, height: 14, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-MEDIUM-MIXED",
        available: 999,
        container: {
          innerDimensions: { length: 21, width: 18, height: 16, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };
  const plan = planShipments(order, inventory, {
    soloShippingCosts: new Map([
      [
        "AA-LARGE-SOLO",
        {
          sku: "AA-LARGE-SOLO",
          shipmentCount: 100,
          averageCostUsd: 15,
          medianCostUsd: 12
        }
      ],
      [
        "AA-SMALL-B",
        {
          sku: "AA-SMALL-B",
          shipmentCount: 100,
          averageCostUsd: 35,
          medianCostUsd: 35
        }
      ]
    ])
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 2);
  assert.equal(plan.shipments[0]?.containerSku, null);
  assert.deepEqual(plan.shipments[0]?.lines, [{ orderLineId: "line-1", sku: "AA-LARGE-SOLO", quantity: 1 }]);
  assert.equal(plan.shipments[1]?.containerSku, "ABOX-MEDIUM-MIXED");
  assert.deepEqual(
    plan.shipments[1]?.lines.map((line) => `${line.sku}:${line.quantity}`),
    ["AA-MEDIUM-A:2", "AA-SMALL-B:2"]
  );
  assert.match(plan.shipments[0]?.reasons.join(" ") ?? "", /Historical solo median/);
});

test("records newly solved SKU and carton combinations", () => {
  class RecordingStore extends InMemoryKnownCombinationStore {
    public recorded: KnownCombinationRecord[] = [];

    override put(record: KnownCombinationRecord): void {
      this.recorded.push(record);
      super.put(record);
    }
  }

  const knownCombinations = new RecordingStore();
  const plan = planShipments(baseOrder, baseInventory, { knownCombinations });

  assert.equal(plan.status, "ready");
  assert.equal(knownCombinations.recorded.length, 1);
  assert.equal(knownCombinations.recorded[0]?.cartonSku, "ABOX-MEDIUM");
  assert.deepEqual(
    knownCombinations.recorded[0]?.itemSummary.map((line) => `${line.sku}:${line.quantity}`),
    ["AA-SMALL-A:2", "AA-SMALL-B:1"]
  );
});

test("re-proves a legacy combination before using it as a known fit", () => {
  const key = knownCombinationKey(baseOrder.lines);
  const knownCombinations = new InMemoryKnownCombinationStore([
    createKnownCombinationRecord(key, baseOrder.lines, "ABOX-MEDIUM", {
      length: 12,
      width: 10,
      height: 8,
      unit: "in"
    })
  ]);

  const first = planShipments(baseOrder, baseInventory, { knownCombinations });
  assert.match(first.shipments[0]?.reasons.join(" ") ?? "", /Each rigid item can be placed/);
  assert.ok(knownCombinations.getAll(key).some((record) => record.geometryProofVersion === 2));

  const plan = planShipments(baseOrder, baseInventory, { knownCombinations });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-MEDIUM");
  assert.match(plan.shipments[0]?.reasons.join(" ") ?? "", /Known combination matched ABOX-MEDIUM/);
});

test("loads tracked historical precedent seeds alongside the local solution store", async () => {
  const fs = await import("node:fs/promises");
  const seed = JSON.parse(await fs.readFile("../../src/dv1/data/historical-known-combinations.json", "utf8")) as {
    records: KnownCombinationRecord[];
  };
  const store = new JsonFileKnownCombinationStore("/tmp/delineator-empty-known.json", [
    "../../src/dv1/data/historical-known-combinations.json"
  ]);

  const first = seed.records[0];
  assert.ok(first);
  assert.equal(store.getAll(first.key)[0]?.provenance, "historical_import");
});

test("keeps human-confirmed provenance even when a legacy row falsely claims a geometry proof", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [{
      id: "line-1",
      sku: "AA-LONG-A",
      quantity: 2,
      dimensions: { length: 7, width: 4, height: 1.1, unit: "in" }
    }]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-LONG-A", available: 2 },
      {
        sku: "ABOX-HISTORICAL",
        available: 1,
        container: {
          innerDimensions: { length: 8, width: 4, height: 2, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };
  const knownCombinations = new InMemoryKnownCombinationStore([
    createKnownCombinationRecord(
      knownCombinationKey(order.lines),
      order.lines,
      "ABOX-HISTORICAL",
      { length: 8, width: 4, height: 2, unit: "in" },
      { provenance: "human_confirmed", warehouseId: "reno-main", sourceNote: "Warehouse-confirmed trial pack" }
    ),
    createKnownCombinationRecord(
      knownCombinationKey(order.lines), order.lines, "ABOX-HISTORICAL",
      { length: 8, width: 4, height: 2, unit: "in" },
      { provenance: "geometry_validated", warehouseId: "reno-main" }
    )
  ]);

  const plan = planShipments(order, inventory, { knownCombinations });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-HISTORICAL");
  assert.match(plan.shipments[0]?.reasons.join(" ") ?? "", /Warehouse-proven precedent/);
  assert.doesNotMatch(plan.shipments[0]?.reasons.join(" ") ?? "", /Each rigid item can be placed/);
  const repeat = planShipments(order, inventory, { knownCombinations });
  assert.match(repeat.shipments[0]?.reasons.join(" ") ?? "", /Warehouse-proven precedent/);
  assert.equal(knownCombinations.all().length, 2);
  assert.ok(knownCombinations.all().every((record) => record.geometryProofVersion === undefined));
});

test("keeps restricted lines separate when canPackWith is empty", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [
      ...baseOrder.lines,
      {
        id: "line-3",
        sku: "AA-FRAGILE-C",
        quantity: 1,
        dimensions: { length: 4, width: 4, height: 4, unit: "in" },
        weight: { value: 1, unit: "lb" },
        packGroup: "fragile",
        canPackWith: []
      }
    ]
  };
  const inventory: InventorySnapshot = {
    ...baseInventory,
    items: [{ sku: "AA-FRAGILE-C", available: 1 }, ...baseInventory.items]
  };

  const plan = planShipments(order, inventory);
  const fragileShipment = plan.shipments.find((shipment) =>
    shipment.lines.some((line) => line.sku === "AA-FRAGILE-C")
  );

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 2);
  assert.deepEqual(fragileShipment?.lines, [{ orderLineId: "line-3", sku: "AA-FRAGILE-C", quantity: 1 }]);
});

test("records the warehouse selected for same-location consolidation", () => {
  const plan = planShipments(baseOrder, baseInventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments[0]?.warehouseId, "reno-main");
  assert.match(plan.shipments[0]?.reasons.join(" ") ?? "", /Surpath warehouse reno-main/);
});

test("does not consolidate items that are only available from different warehouses", () => {
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-SMALL-A", available: 2, warehouseId: "reno-main" },
      { sku: "AA-SMALL-B", available: 1, warehouseId: "dallas-overflow" },
      {
        sku: "ABOX-MEDIUM",
        available: 2,
        warehouseId: "reno-main",
        container: {
          innerDimensions: { length: 12, width: 10, height: 8, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-MEDIUM",
        available: 2,
        warehouseId: "dallas-overflow",
        container: {
          innerDimensions: { length: 12, width: 10, height: 8, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(baseOrder, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 2);
  assert.deepEqual(
    plan.shipments.map((shipment) => ({
      warehouseId: shipment.warehouseId,
      containerSku: shipment.containerSku,
      skus: shipment.lines.map((line) => line.sku)
    })),
    [
      { warehouseId: "reno-main", containerSku: "ABOX-MEDIUM", skus: ["AA-SMALL-A"] },
      { warehouseId: "dallas-overflow", containerSku: null, skus: ["AA-SMALL-B"] }
    ]
  );
});

test("ships solo when item stock exists but matching-location carton stock does not", () => {
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-SMALL-A", available: 10, warehouseId: "reno-main" },
      { sku: "AA-SMALL-B", available: 10, warehouseId: "reno-main" },
      {
        sku: "ABOX-MEDIUM",
        available: 2,
        warehouseId: "dallas-overflow",
        container: {
          innerDimensions: { length: 12, width: 10, height: 8, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(baseOrder, inventory);

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 3);
  assert.deepEqual(plan.shipments.map((shipment) => shipment.warehouseId), ["reno-main", "reno-main", "reno-main"]);
  assert.deepEqual(plan.shipments.map((shipment) => shipment.containerSku), [null, null, null]);
  assert.deepEqual(
    plan.shipments.map((shipment) => shipment.lines),
    [
      [{ orderLineId: "line-1", sku: "AA-SMALL-A", quantity: 1 }],
      [{ orderLineId: "line-1", sku: "AA-SMALL-A", quantity: 1 }],
      [{ orderLineId: "line-2", sku: "AA-SMALL-B", quantity: 1 }]
    ]
  );
});

test("splits one SKU quantity across warehouses when no single location has enough stock", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [
      {
        id: "line-1",
        sku: "AA-SPLIT-A",
        quantity: 3,
        dimensions: { length: 6, width: 4, height: 2, unit: "in" }
      }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-SPLIT-A", available: 1, warehouseId: "reno-main" },
      { sku: "AA-SPLIT-A", available: 2, warehouseId: "dallas-overflow" }
    ]
  };

  const plan = planShipments(order, inventory);

  assert.equal(plan.status, "ready");
  assert.deepEqual(
    plan.shipments.map((shipment) => ({
      warehouseId: shipment.warehouseId,
      lines: shipment.lines
    })),
    [
      {
        warehouseId: "reno-main",
        lines: [{ orderLineId: "line-1", sku: "AA-SPLIT-A", quantity: 1 }]
      },
      {
        warehouseId: "dallas-overflow",
        lines: [{ orderLineId: "line-1", sku: "AA-SPLIT-A", quantity: 1 }]
      },
      {
        warehouseId: "dallas-overflow",
        lines: [{ orderLineId: "line-1", sku: "AA-SPLIT-A", quantity: 1 }]
      }
    ]
  );
});

test("evaluates warehouse allocation and packing together with an origin rate estimator", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    lines: [
      { ...baseOrder.lines[0], quantity: 1 },
      { ...baseOrder.lines[1], quantity: 1 }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "reno-main",
    items: [
      { sku: "AA-SMALL-A", available: 1, warehouseId: "reno-main" },
      { sku: "AA-SMALL-B", available: 1, warehouseId: "reno-main" },
      { sku: "AA-SMALL-A", available: 1, warehouseId: "dallas-overflow" },
      { sku: "AA-SMALL-B", available: 1, warehouseId: "dallas-overflow" },
      {
        sku: "ABOX-RENO",
        available: 1,
        warehouseId: "reno-main",
        container: {
          innerDimensions: { length: 12, width: 10, height: 8, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      },
      {
        sku: "ABOX-DALLAS",
        available: 1,
        warehouseId: "dallas-overflow",
        container: {
          innerDimensions: { length: 20, width: 20, height: 20, unit: "in" },
          maxWeight: { value: 20, unit: "lb" }
        }
      }
    ]
  };

  const plan = planShipments(order, inventory, {
    rateEstimator: ({ shipment, defaultProxyCost }) =>
      shipment.warehouseId === "dallas-overflow" ? 1 : defaultProxyCost + 100
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.warehouseId, "dallas-overflow");
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-DALLAS");
});

test("passes destination, origin, package, and FedEx Ground inputs to the rate estimator", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    warehouseId: "LA-SPI1",
    destination: { postalCode: "30548", countryCode: "US" },
    lines: [
      { id: "line-1", sku: "AA-SMALL-A", quantity: 1, dimensions: { length: 4, width: 4, height: 4, unit: "in" }, weight: { value: 5, unit: "lb" } },
      { id: "line-2", sku: "AA-SMALL-B", quantity: 1, dimensions: { length: 4, width: 4, height: 4, unit: "in" }, weight: { value: 5, unit: "lb" } }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "LA-SPI1",
    items: [
      { sku: "AA-SMALL-A", available: 1, warehouseId: "LA-SPI1" },
      { sku: "AA-SMALL-B", available: 1, warehouseId: "LA-SPI1" },
      { sku: "AA-SMALL-A", available: 1, warehouseId: "GA-VLH1" },
      { sku: "AA-SMALL-B", available: 1, warehouseId: "GA-VLH1" },
      { sku: "ABOX-CA", available: 1, warehouseId: "LA-SPI1", container: { innerDimensions: { length: 8, width: 8, height: 8, unit: "in" }, maxWeight: { value: 20, unit: "lb" } } },
      { sku: "ABOX-GA", available: 1, warehouseId: "GA-VLH1", container: { innerDimensions: { length: 12, width: 10, height: 8, unit: "in" }, maxWeight: { value: 20, unit: "lb" } } }
    ]
  };

  const contexts: Array<{ destination?: unknown; origin?: unknown; serviceLevel?: unknown; packageWeight?: unknown; packageDimensions?: unknown }> = [];
  const plan = planShipments(order, inventory, {
    rateConfig: DEFAULT_FEDEX_GROUND_RATE_CONFIG,
    rateEstimator: (context) => {
      contexts.push(context);
      return context.warehouseId === "GA-VLH1" ? 1 : 100;
    }
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.warehouseId, "GA-VLH1");
  assert.equal(contexts.some((context) => (context.destination as { postalCode?: string })?.postalCode === "30548"), true);
  assert.equal(contexts.some((context) => (context.origin as { code?: string })?.code === "GA-VLH1"), true);
  assert.equal(contexts.some((context) => context.serviceLevel === "FEDEX_GROUND"), true);
  assert.equal(contexts.some((context) => (context.packageWeight as { value?: number })?.value === 10), true);
});

test("converts millimeter carton dimensions before comparative rate scoring", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    warehouseId: "LA-SPI1",
    destination: { postalCode: "90703", countryCode: "US" },
    lines: [
      { id: "line-1", sku: "AA-MM-A", quantity: 1, dimensions: { length: 100, width: 100, height: 100, unit: "mm" }, weight: { value: 1, unit: "lb" } },
      { id: "line-2", sku: "AA-MM-B", quantity: 1, dimensions: { length: 100, width: 100, height: 100, unit: "mm" }, weight: { value: 1, unit: "lb" } }
    ]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "LA-SPI1",
    items: [
      ...order.lines.map((line) => ({ sku: line.sku, available: 1, warehouseId: "LA-SPI1" })),
      ...[
        ["ABOX0002", { length: 500, width: 360, height: 310, unit: "mm" as const }],
        ["ABOX-MM", { length: 220, width: 110, height: 110, unit: "mm" as const }]
      ].map(([sku, innerDimensions]) => ({
        sku: sku as string,
        available: 1,
        warehouseId: "LA-SPI1",
        container: { innerDimensions: innerDimensions as Dimensions, maxWeight: { value: 20, unit: "lb" as const } }
      }))
    ]
  };

  const plan = planShipments(order, inventory, { rateConfig: DEFAULT_FEDEX_GROUND_RATE_CONFIG });

  assert.equal(plan.status, "ready");
  assert.equal(plan.shipments.length, 1);
  assert.equal(plan.shipments[0]?.containerSku, "ABOX-MM");
});

test("marks the plan for review when Shopify destination data is missing for rate optimization", () => {
  const plan = planShipments(baseOrder, baseInventory, { rateConfig: DEFAULT_FEDEX_GROUND_RATE_CONFIG });

  assert.equal(plan.status, "needs_review");
  assert.equal(plan.exceptions[0]?.code, "MISSING_RATE_DATA");
  assert.match(plan.exceptions[0]?.message ?? "", /destination/);
});

test("does not flag rate origins for ignored or unrelated inventory warehouses", () => {
  const order: NormalizedOrder = {
    ...baseOrder,
    warehouseId: "unknown",
    destination: { postalCode: "90703", countryCode: "US" },
    lines: [{ ...baseOrder.lines[0], quantity: 1 }]
  };
  const inventory: InventorySnapshot = {
    warehouseId: "unknown",
    items: [
      { sku: "AA-SMALL-A", available: 1, warehouseId: "LA-SPI1" },
      { sku: "VN-BIKE", available: 100, warehouseId: "NJ-RSR7" },
      { sku: "ABOX0001", available: 10, warehouseId: "LA-SPI1", container: {
        innerDimensions: { length: 20, width: 20, height: 20, unit: "in" },
        maxWeight: { value: 20, unit: "lb" }
      } }
    ]
  };

  const plan = planShipments(order, inventory, { rateConfig: DEFAULT_FEDEX_GROUND_RATE_CONFIG });

  assert.equal(plan.exceptions.some((exception) => exception.code === "MISSING_RATE_DATA"), false);
});

test("reserves duplicate SKU quantities across the order and at each warehouse", () => {
  const original = baseOrder.lines[0];
  const inventory = {
    warehouseId: baseOrder.warehouseId,
    items: [
      { sku: original.sku, available: 1 },
      { sku: original.sku, available: 1, warehouseId: "overflow" }
    ]
  };
  for (const canPackWith of [undefined, []]) {
    const order = { ...baseOrder, lines: [
      { ...original, quantity: 1, canPackWith },
      { ...original, id: "duplicate", quantity: 1 }
    ] };
    const shortage = planShipments(order, { ...inventory, items: inventory.items.slice(0, 1) });
    assert.equal(shortage.status, "needs_review");
    assert.equal(shortage.exceptions[0]?.code, "INSUFFICIENT_ITEM_INVENTORY");
    assert.deepEqual(shortage.exceptions[0]?.orderLineIds, [original.id, "duplicate"]);
    assert.equal(shortage.shipments.length, 0);

    const sufficient = planShipments(order, inventory);
    assert.equal(sufficient.status, "ready");
    assert.deepEqual(sufficient.shipments.map((shipment) => shipment.warehouseId).sort(), ["overflow", baseOrder.warehouseId]);
  }

  const largeOrder = { ...baseOrder, lines: [
    { ...original, quantity: 7 },
    { ...original, id: "duplicate", quantity: 6 }
  ] };
  const largeInventory = { ...inventory, items: inventory.items.map((item, i) => ({ ...item, available: i === 0 ? 7 : 6 })) };
  const large = planShipments(largeOrder, largeInventory);
  assert.equal(large.status, "ready");
  assert.equal(large.shipments.filter((shipment) => shipment.warehouseId === baseOrder.warehouseId).length, 7);
  assert.equal(large.shipments.filter((shipment) => shipment.warehouseId === "overflow").length, 6);
});

test("mixed-unit lines cannot share a carton even when raw numbers would fit", () => {
  const inch: Dimensions = { length: 10, width: 1, height: 1, unit: "in" };
  const millimeter: Dimensions = { length: 1, width: 1, height: 1, unit: "mm" };
  const order = { ...baseOrder, lines: [
    { ...baseOrder.lines[0], quantity: 1, dimensions: millimeter },
    { ...baseOrder.lines[1], dimensions: inch }
  ] };
  const inventory: InventorySnapshot = { ...baseInventory, items: [
    ...baseInventory.items.slice(0, 2),
    {
      sku: "ABOX-MM",
      available: 1,
      container: { innerDimensions: { length: 15, width: 15, height: 15, unit: "mm" }, maxWeight: { value: 20, unit: "lb" } }
    }
  ] };
  const plan = planShipments(order, inventory);
  assert.equal(plan.status, "needs_review");
  assert.deepEqual(plan.exceptions.find(({ code }) => code === "UNIT_MISMATCH")?.orderLineIds, [order.lines[1].id]);
  assert.equal(plan.shipments.length, 2);
  assert.ok(plan.shipments.every(({ containerSku }) => containerSku === null));
});

test("rates exact, greedy, and cached carton fits above a legacy weight limit", () => {
  for (const quantity of [2, 17]) {
    const dimensions: Dimensions = { length: 1, width: 1, height: 1, unit: "in" };
    const cartonDimensions: Dimensions = { length: 4, width: 4, height: 4, unit: "in" };
    const order: NormalizedOrder = { ...baseOrder, lines: [
      { ...baseOrder.lines[0], quantity, dimensions, weight: { value: 11, unit: "lb" } }
    ] };
    const cartonSku = "ABOX-LEGACY";
    const inventory: InventorySnapshot = { warehouseId: baseOrder.warehouseId, items: [
      { sku: order.lines[0].sku, available: quantity },
      { sku: cartonSku, available: 1, container: { innerDimensions: cartonDimensions, maxWeight: { value: 20, unit: "lb" } } }
    ] };
    const historical = createKnownCombinationRecord(
      knownCombinationKey(order.lines), order.lines, cartonSku, cartonDimensions, { provenance: "historical_import", warehouseId: baseOrder.warehouseId }
    );

    for (const records of [[], [historical]]) {
      const ratedWeights: number[] = [];
      const plan = planShipments(order, inventory, {
        knownCombinations: new InMemoryKnownCombinationStore(records),
        rateEstimator: ({ shipment, packageWeight }) => {
          if (!shipment.containerSku) return 100;
          if (packageWeight) ratedWeights.push(packageWeight.value);
          return 1;
        }
      });
      assert.equal(plan.status, "ready");
      assert.equal(plan.shipments.length, 1);
      assert.equal(plan.shipments[0]?.containerSku, cartonSku);
      assert.equal(plan.shipments[0]?.lines[0]?.quantity, quantity);
      assert.ok(ratedWeights.includes(quantity * 11));
    }
  }
});

test("candidate scores preserve unit weights and drive selection", () => {
  const dimensions: Dimensions = { length: 1, width: 1, height: 1, unit: "in" };
  const order: NormalizedOrder = { ...baseOrder, lines: [
    { ...baseOrder.lines[0], quantity: 2, dimensions, weight: { value: 8, unit: "lb" } }
  ] };
  const weights: Array<number | undefined> = [];
  const plan = planShipments(order, baseInventory, {
    rateEstimator: ({ shipment, packageWeight }) => {
      if (!shipment.containerSku) return 5;
      weights.push(packageWeight?.value);
      return (packageWeight?.value ?? 0) > 10 ? 100 : 1;
    }
  });
  assert.deepEqual(weights, [16]);
  assert.equal(plan.shipments.length, 2);
  assert.ok(plan.shipments.every(({ containerSku }) => containerSku === null));
});

test("the large-order fallback compares cartons with individual solo shipments", () => {
  const dimensions: Dimensions = { length: 1, width: 1, height: 1, unit: "in" };
  const order = { ...baseOrder, lines: [{ ...baseOrder.lines[0], quantity: 17, dimensions }] };
  const inventory = {
    ...baseInventory,
    items: baseInventory.items.map((item) => item.sku === order.lines[0].sku ? { ...item, available: 17 } : item)
  };
  for (const items of [inventory.items, inventory.items.filter(({ container }) => !container)]) {
    const plan = planShipments(order, { ...inventory, items }, {
      rateEstimator: ({ shipment }) => shipment.containerSku ? 1000 : 1
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.shipments.length, 17);
    assert.ok(plan.shipments.every(({ containerSku, lines }) => containerSku === null && lines[0]?.quantity === 1));
  }

  const cheaperCarton = planShipments(order, inventory, {
    rateEstimator: ({ shipment }) => shipment.containerSku ? 10 : 1
  });
  assert.equal(cheaperCarton.shipments.length, 1);
  assert.equal(cheaperCarton.shipments[0]?.containerSku, "ABOX-MEDIUM");
});

test("warehouse-proven precedents allow diagonal fits only for the recorded combination and warehouse", () => {
  const dims = (length: number, width: number, height: number): Dimensions => ({ length, width, height, unit: "in" });
  const order: NormalizedOrder = { ...baseOrder, lines: [
    { id: "bar", sku: "AA-BAR", quantity: 1, dimensions: dims(10, 1, 1) },
    { id: "cube", sku: "AA-CUBE", quantity: 1, dimensions: dims(1, 1, 1) }
  ] };
  const warehouseId = order.warehouseId;
  const cartonSku = "ABOX-DIAGONAL";
  const cartonDimensions = dims(8, 8, 2);
  const inventory = { warehouseId, items: [
    ...order.lines.map(({ sku }) => ({ sku, available: 2 })),
    { sku: cartonSku, available: 1, container: { innerDimensions: cartonDimensions } }
  ] };
  const plan = (records: KnownCombinationRecord[], stock = inventory, requested = order) =>
    planShipments(requested, stock, { knownCombinations: new InMemoryKnownCombinationStore(records) });
  assert.ok(plan([]).shipments.every(({ containerSku }) => containerSku === null));

  for (const provenance of ["human_confirmed", "historical_import"] as const) {
    const record = createKnownCombinationRecord(
      knownCombinationKey(order.lines), order.lines, cartonSku, cartonDimensions,
      { warehouseId, provenance, sourceOrderNumber: "WS-#10100", sourceNote: "Verified fixture" }
    );
    const result = plan([record]);
    assert.equal(result.shipments.length, 1);
    assert.equal(result.shipments[0]?.containerSku, cartonSku);
    assert.match(result.shipments[0]?.reasons.join(" ") ?? "", /Warehouse-proven precedent.*off-axis/);

    assert.ok(plan([{ ...record, warehouseId: "other" }]).shipments.every((shipment) => !shipment.containerSku));
    assert.ok(plan([{ ...record, warehouseId: undefined }]).shipments.every((shipment) => !shipment.containerSku));
    assert.ok(plan([{ ...record, cartonDimensions: dims(9, 8, 2) }]).shipments.every((shipment) => !shipment.containerSku));
    assert.ok(plan([record], { ...inventory, items: inventory.items.slice(0, 2) })
      .shipments.every((shipment) => !shipment.containerSku));
    const changed = { ...order, lines: [{ ...order.lines[0], quantity: 2 }, order.lines[1]] };
    const split = plan([record], inventory, changed).shipments;
    assert.equal(split.length, 2);
    assert.deepEqual(split.find((shipment) => shipment.containerSku)?.lines.map(({ sku, quantity }) => [sku, quantity]),
      [["AA-BAR", 1], ["AA-CUBE", 1]]);
    assert.deepEqual(split.find((shipment) => !shipment.containerSku)?.lines.map(({ sku, quantity }) => [sku, quantity]),
      [["AA-BAR", 1]]);
    const short = { ...inventory, items: inventory.items.filter(({ sku }) => sku !== "AA-BAR") };
    assert.equal(plan([record], short).status, "needs_review");
  }
});
