import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichSurpathRowsWithShopifyItemNames,
  exactRowsForOrderIdentifier,
  exactRowsForNoTrackingShipment,
  exactRowsForUnfulfilledItems,
  findDirectSurpathRows,
  mergeShopifyGaps,
} from "../src/tracking/surpathTracking.js";
import { normalizeOrderIdentifier } from "../src/orderIds.js";

const shippingAddress = {
  company: "River City Bicycles",
  address1: "321 SE Alder St",
  zip: "97214",
};

const unfulfilledItems = [
  { sku: "VGM10001A", quantity: 10 },
  { sku: "VGM10002A", quantity: 12 },
  { sku: "VGM10003A", quantity: 10 },
  { sku: "VF030001B", quantity: 3 },
  { sku: "VF030002B", quantity: 3 },
  { sku: "VF030003B", quantity: 4 },
  { sku: "VF030004B", quantity: 3 },
  { sku: "VF030005B", quantity: 3 },
];

const noTrackingShipment = {
  items: [
    { sku: "VB010001B", quantity: 1 },
    { sku: "VB010005B", quantity: 2 },
    { sku: "VB010010B", quantity: 2 },
  ],
};

function surpathRow(overrides) {
  return {
    id: overrides.id,
    wmsOutboundCode: overrides.wmsOutboundCode,
    zip: "97214",
    company: "River City Bicycles",
    street1: "321 SE Alder St",
    status: "待出库",
    ...overrides,
  };
}

test("matches direct Surpath rows by Shopify WS number in customerPlatformCode", () => {
  const rows = exactRowsForOrderIdentifier({
    data: [
      surpathRow({ id: "1801021", customerPlatformCode: "WS-#32303", platformCode: "OT359826060600096", sku: "MKT_Triker_Bundle" }),
      surpathRow({ id: "1801020", customerPlatformCode: "WS-#32303", platformCode: "OT359826060600095", sku: "MIBDT201A" }),
      surpathRow({ id: "1801019", customerPlatformCode: "WS-#99999", platformCode: "OT359826060600094", sku: "MKT_N2X_Bundle" }),
    ],
  }, normalizeOrderIdentifier("32303"));

  assert.deepEqual(rows.map((row) => row.sku), ["MKT_Triker_Bundle", "MIBDT201A"]);
});

test("loads every direct Surpath page for large orders", async () => {
  const allRows = Array.from({ length: 121 }, (_, index) => surpathRow({
    id: String(index + 1),
    customerPlatformCode: "WS-#31783",
    platformCode: `OT${index + 1}`,
    sku: `SKU-${index + 1}`,
  }));
  const calls = [];
  const surpathClient = {
    async queryOutboundOrders(params) {
      calls.push(params);
      const start = (params.currentPage - 1) * params.pageSize;
      return {
        totalSize: allRows.length,
        data: allRows.slice(start, start + params.pageSize),
      };
    },
  };

  const rows = await findDirectSurpathRows(surpathClient, normalizeOrderIdentifier("31783"));

  assert.equal(rows.length, 121);
  assert.deepEqual(calls.map((call) => call.currentPage), [1, 2]);
  assert.deepEqual(calls.map((call) => call.pageSize), [100, 100]);
});

test("matches unfulfilled Surpath LTL group when all rows fit Shopify quantities", () => {
  const rows = exactRowsForUnfulfilledItems({
    data: [
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VGM10001A", quantity: 10 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VGM10002A", quantity: 12 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VGM10003A", quantity: 10 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VF030001B", quantity: 3 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VF030002B", quantity: 3 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VF030003B", quantity: 4 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VF030004B", quantity: 3 }),
      surpathRow({ id: "1773380", wmsOutboundCode: "OT359826052800660", sku: "VF030005B", quantity: 3 }),
    ],
  }, unfulfilledItems, shippingAddress);

  assert.equal(rows.length, 8);
  assert.equal(rows.reduce((total, row) => total + row.quantity, 0), 48);
});

test("matches no-tracking Shopify shipment inside a larger Surpath LTL group", () => {
  const rows = exactRowsForNoTrackingShipment({
    data: [
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010001B", quantity: 1 }),
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010005B", quantity: 2 }),
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010008A", quantity: 1 }),
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010010B", quantity: 2 }),
    ],
  }, noTrackingShipment, shippingAddress);

  assert.deepEqual(rows.map((row) => row.sku), ["VB010001B", "VB010005B", "VB010010B"]);
  assert.equal(rows.reduce((total, row) => total + row.quantity, 0), 5);
});

test("rejects no-tracking Shopify shipment when matched Surpath quantities differ", () => {
  const rows = exactRowsForNoTrackingShipment({
    data: [
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010001B", quantity: 1 }),
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010005B", quantity: 3 }),
      surpathRow({ id: "1749577", wmsOutboundCode: "A001-260520-0704", sku: "VB010010B", quantity: 2 }),
    ],
  }, noTrackingShipment, shippingAddress);

  assert.deepEqual(rows, []);
});

test("keeps full Shopify item names on Surpath rows matched by inferred SKU", () => {
  const rows = enrichSurpathRowsWithShopifyItemNames([
    surpathRow({ id: "1772297", wmsOutboundCode: "", sku: "SDM10304B", name: "Freewheel飞轮", quantity: 1 }),
    surpathRow({ id: "1772297", wmsOutboundCode: "", sku: "SDM10303A", name: "Rear Derailleur", quantity: 1 }),
  ], {
    unfulfilledItems: [
      { sku: "SDM10304B", name: "SDM10304B - DM Cassette", quantity: 1 },
      { sku: "SDM10303A", name: "SDM10303A - DM Rear Derailleur", quantity: 1 },
    ],
    shipments: [],
  });

  assert.equal(rows[0].name, "SDM10304B - DM Cassette");
  assert.equal(rows[1].name, "SDM10303A - DM Rear Derailleur");
});

test("keeps Shopify-only unfulfilled items after direct Surpath shipments are found", () => {
  const merged = mergeShopifyGaps({
    shipments: [{
      items: [
        { sku: "MKT_Triker_Bundle", quantity: 1, name: "MKT_Triker_Onepager&Handlebar Tag" },
      ],
      tracking: [{ trackingNumber: "381836270544" }],
    }],
    unfulfilledItems: [],
    warnings: [],
  }, {
    shipments: [],
    unfulfilledItems: [
      { sku: "MKT_Triker_Bundle", quantity: 1, name: "MKT_Triker_Onepager&Handlebar Tag" },
      { sku: "MKT_GOMAD_Bundle", quantity: 1, name: "MKT_GOMAD_Onepager&Handlebar Tag" },
    ],
  }, new Set(["381836270544"]));

  assert.deepEqual(merged.unfulfilledItems, [{
    sku: "MKT_GOMAD_Bundle",
    quantity: 1,
    name: "MKT_GOMAD_Onepager&Handlebar Tag",
  }]);
});

test("rejects overlapping Surpath LTL group that includes SKUs outside the Shopify order", () => {
  const rows = exactRowsForUnfulfilledItems({
    data: [
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VGM10001A", quantity: 5 }),
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VGM10002A", quantity: 9 }),
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VGM10003A", quantity: 5 }),
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VF030001B", quantity: 1 }),
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VS020001A", quantity: 2 }),
      surpathRow({ id: "1773366", wmsOutboundCode: "OT359826052800646", sku: "VB010009B", quantity: 1 }),
    ],
  }, unfulfilledItems, shippingAddress);

  assert.deepEqual(rows, []);
});

test("rejects overlapping Surpath LTL group that exceeds Shopify unfulfilled quantity", () => {
  const rows = exactRowsForUnfulfilledItems({
    data: [
      surpathRow({ id: "1773399", wmsOutboundCode: "OT359826052800699", sku: "VGM10001A", quantity: 11 }),
      surpathRow({ id: "1773399", wmsOutboundCode: "OT359826052800699", sku: "VGM10002A", quantity: 12 }),
    ],
  }, unfulfilledItems, shippingAddress);

  assert.deepEqual(rows, []);
});
