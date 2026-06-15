import test from "node:test";
import assert from "node:assert/strict";
import { exactRowsForTracking, normalizeSurpathRows } from "../src/surpath/normalize.js";
import { formatTrackingReply } from "../src/formatters/trackingReply.js";

test("normalizes Surpath rows into Lantern shipments grouped by tracking", () => {
  const summary = normalizeSurpathRows([
    {
      expressNumber: "872018610504",
      expressFromCode: "US_FEDEX_OS",
      status: "派送中",
      sku: "VTK10003B",
      quantity: 1,
      lastTrack: "[BARRINGTON, NJ, US] On the way",
      lastTrackTime: "2026-05-26 18:07:34",
      warehouseCode: "LA-SPI1",
    },
    {
      expressNumber: "872018610504",
      expressFromCode: "US_FEDEX_OS",
      status: "派送中",
      sku: "ACC-1",
      quantity: 2,
      lastTrack: "[BARRINGTON, NJ, US] On the way",
      lastTrackTime: "2026-05-26 18:07:34",
      warehouseCode: "LA-SPI1",
    },
  ], {
    orderName: "WS-#29560",
    requestedOrder: "29560",
  });

  assert.equal(summary.found, true);
  assert.equal(summary.shipments.length, 1);
  assert.equal(summary.shipments[0].status, "In Transit");
  assert.equal(summary.shipments[0].tracking[0].carrier, "FedEx");
  assert.equal(summary.shipments[0].tracking[0].carrierConfidence, "confirmed");
  assert.equal(summary.shipments[0].tracking[0].trackingNumber, "872018610504");
  assert.deepEqual(summary.shipments[0].items, [
    { name: "VTK10003B", sku: "VTK10003B", quantity: 1 },
    { name: "ACC-1", sku: "ACC-1", quantity: 2 },
  ]);
});

test("filters Surpath broad matches to exact tracking rows", () => {
  const rows = exactRowsForTracking({
    data: [
      { expressNumber: "872018610504", sku: "MATCH" },
      { expressNumber: "399541862020", sku: "PARTIAL" },
    ],
  }, "872018610504");

  assert.deepEqual(rows, [{ expressNumber: "872018610504", sku: "MATCH" }]);
});

test("formats Surpath latest update when FedEx enrichment is unavailable", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      expressNumber: "729560",
      carrierName: "ABF Freight",
      status: "已妥投",
      deliveredDate: Date.UTC(2026, 0, 20, 16, 34, 5),
      bolCode: "60112915734",
      sku: "VF030003B",
      quantity: 1,
      lastTrack: "[Eugene, OR, US] Delivered",
      lastTrackTime: "2026-01-20T16:34:05Z",
    },
  ], {
    orderName: "WS-#29560",
    requestedOrder: "29560",
  }));

  assert.match(reply, /Status: Delivered/);
  assert.match(reply, /Items: 1x F1 Plus Electric Blue/);
  assert.match(reply, /Latest update: Delivered, Eugene, OR, US, Jan 20, 2026, 8:34 AM/);
  assert.match(reply, /Tracking: \[729560]\(https:\/\/view\.arcb\.com\/nlo\/tools\/tracking/);
  assert.doesNotMatch(reply, /^Link:/m);
  assert.doesNotMatch(reply, /BOL:/);
});

test("formats LTL status as guessed status plus returned status", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      bolCode: "60114378643",
      carrierName: "Priority1",
      status: "Arrived at destination terminal",
      sku: "VTK10003B",
      quantity: 1,
      lastTrack: "[Little Rock, AR] Arrived at destination terminal",
      lastTrackTime: "2026-05-26 18:07:34",
    },
  ], {
    orderName: "WS-#29560",
    requestedOrder: "29560",
  }));

  assert.match(reply, /Status: In Transit - Arrived at destination terminal/);
});

test("formats LTL pre-carrier state as processing plus returned status", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      bolCode: "",
      expressFromCode: "LTL_SELF_PICKUP",
      surpathChannel: "LTL",
      status: "待出库",
      sku: "VT200003A",
      quantity: 3,
    },
  ], {
    orderName: "WS-#30463",
    requestedOrder: "30463",
  }));

  assert.match(reply, /Status: Fulfilled - LtL processing - 待出库/);
  assert.match(reply, /Carrier: LTL \(likely\)/);
});

test("marks Surpath carrier as likely when inferred before tracking is assigned", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      expressFromCode: "US_UPS_PREPAID",
      surpathChannel: "UPS_US2CA",
      status: "待出库",
      sku: "SDM10304B",
      name: "Freewheel飞轮",
      quantity: 1,
    },
  ], {
    orderName: "WS-#30689",
    requestedOrder: "30689",
  }));

  assert.match(reply, /Carrier: UPS \(likely\)/);
  assert.match(reply, /Tracking: Not available yet/);
});

test("keeps FedEx status format standardized without raw Surpath status suffix", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      expressNumber: "872018610504",
      expressFromCode: "US_FEDEX_OS",
      status: "派送中",
      sku: "VTK10003B",
      quantity: 1,
      lastTrack: "[BARRINGTON, NJ, US] On the way",
      lastTrackTime: "2026-05-26 18:07:34",
    },
  ], {
    orderName: "WS-#29560",
    requestedOrder: "29560",
  }));

  assert.match(reply, /Status: In Transit\n/);
  assert.doesNotMatch(reply, /Status: In Transit - 派送中/);
});

test("uses China shipping status for non-delivered 4PX Surpath shipments", () => {
  const reply = formatTrackingReply(normalizeSurpathRows([
    {
      expressNumber: "4PX3002887715470CN",
      carrierName: "4PX",
      status: "派送中",
      sku: "SD050818A-VL06",
      name: "Keys VL06",
      quantity: 1,
    },
  ], {
    orderName: "WS-#32146",
    requestedOrder: "32146",
  }));

  assert.match(reply, /Status: Shipping from China - see tracking - 派送中/);
  assert.match(reply, /Carrier: 4PX/);
  assert.match(reply, /Tracking: \[4PX3002887715470CN]\(https:\/\/track\.4px\.com\/#\/result\/0\/4PX3002887715470CN\)/);
});
