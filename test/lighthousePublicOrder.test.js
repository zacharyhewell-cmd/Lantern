import test from "node:test";
import assert from "node:assert/strict";
import { toLighthouseOrder } from "../src/lighthouse/publicOrder.js";

test("maps tracking data to an explicit Lighthouse allowlist", () => {
  const order = toLighthouseOrder({
    found: true,
    orderId: "gid://shopify/Order/private",
    orderName: "WS-#32303",
    shippingAddress: { name: "Private customer", address1: "Private address" },
    financialStatus: "PAID",
    verification: { shippingPostalCode: "97214" },
    cancelledAt: null,
    unfulfilledItems: [{
      lineItemId: "private-line-id",
      name: "Velotric Rear Rack",
      sku: "AACC0037A",
      quantity: 1,
    }],
    shipments: [{
      source: "surpath",
      status: "Fulfilled - LtL processing",
      rawStatus: "待出库",
      warehouseCode: "private-warehouse",
      items: [{ name: "Velotric Rear Rack", sku: "AACC0037A", quantity: 1 }],
      tracking: [{
        carrier: "LTL",
        carrierConfidence: "likely",
        trackingNumber: "PRO123",
        trackingUrl: "https://carrier.example/PRO123",
        latestUpdate: {
          description: "Pickup scheduled",
          location: "Industry, CA",
          time: "2026-11-13T18:00:00Z",
        },
      }],
    }],
    warnings: ["Tracking is not yet confirmed."],
  });

  assert.deepEqual(order, {
    found: true,
    orderNumber: "WS-#32303",
    cancelledAt: null,
    unfulfilledItems: [{ name: "Rear Rack", quantity: 1 }],
    shipments: [{
      status: "Processing",
      deliveredAt: null,
      estimatedDeliveryAt: null,
      items: [{ name: "Rear Rack", quantity: 1 }],
      tracking: [{
        carrier: "LTL (likely)",
        trackingNumber: "PRO123",
        trackingUrl: "https://carrier.example/PRO123",
        latestUpdate: {
          description: "Pickup scheduled",
          location: "Industry, CA",
          time: "2026-11-13T18:00:00Z",
        },
      }],
    }],
    warnings: ["Tracking is not yet confirmed."],
  });

  assert.equal(JSON.stringify(order).includes("Private customer"), false);
  assert.equal(JSON.stringify(order).includes("private-warehouse"), false);
  assert.equal(JSON.stringify(order).includes("private-line-id"), false);
  assert.equal(JSON.stringify(order).includes("97214"), false);
});

test("translates Chinese public fields and never returns Chinese characters", () => {
  const order = toLighthouseOrder({
    found: true,
    orderName: "WS-#40001",
    unfulfilledItems: [{ name: "Freewheel飞轮", sku: "SDM10304B", quantity: 1 }],
    shipments: [{
      source: "surpath",
      status: "In Transit",
      rawStatus: "派送中",
      items: [{ name: "Charger充电器", sku: "SDM10305B", quantity: 1 }],
      tracking: [{
        carrier: "递四方",
        trackingNumber: "4PX40001",
        latestUpdate: {
          description: "包裹正在派送",
          location: "中国深圳",
          time: "2026-11-13T18:00:00Z",
        },
      }],
    }, {
      source: "surpath",
      status: "Fulfilled - LtL processing",
      rawStatus: "待出库",
      items: [{ name: "未知配件", sku: "PART40001", quantity: 1 }],
      tracking: [{
        carrier: "未知承运商",
        trackingNumber: "TRACK40001",
        latestUpdate: {
          description: "未知物流动态",
          location: "未知地点",
        },
      }],
    }],
    warnings: ["请联系承运商"],
  });

  const outForDelivery = order.shipments.find((shipment) => shipment.status === "Out for delivery");
  const processing = order.shipments.find((shipment) => shipment.status === "Processing");

  assert.equal(order.unfulfilledItems[0].name, "Freewheel");
  assert.ok(outForDelivery);
  assert.equal(outForDelivery.items[0].name, "Charger");
  assert.equal(outForDelivery.tracking[0].carrier, "4PX");
  assert.equal(outForDelivery.tracking[0].latestUpdate.description, "Package Out for delivery");
  assert.equal(outForDelivery.tracking[0].latestUpdate.location, "China Shenzhen");
  assert.ok(processing);
  assert.equal(processing.items[0].name, "PART40001");
  assert.equal(processing.tracking[0].carrier, "Carrier");
  assert.equal(processing.tracking[0].latestUpdate.description, "Carrier update received");
  assert.equal(processing.tracking[0].latestUpdate.location, null);
  assert.deepEqual(order.warnings, ["Additional shipment information is available."]);
  assert.doesNotMatch(JSON.stringify(order), /\p{Script=Han}/u);
});

test("consolidates Lighthouse statuses into a closed public lifecycle", () => {
  const cases = [
    { status: "Unfulfilled", rawStatus: "待出库", expected: "Processing" },
    { status: "Fulfilled - LtL processing", rawStatus: "未出库", expected: "Processing" },
    { status: "Waiting for pickup", rawStatus: "已出库-待上网", expected: "Waiting for pickup" },
    { status: "Waiting for pickup", rawStatus: "待提货", expected: "Waiting for pickup" },
    { status: "Shipping from China - see tracking", rawStatus: "运输途中", expected: "In Transit" },
    { status: "Fulfilled - LtL processing", rawStatus: "清关完成", expected: "In Transit" },
    { status: "In Transit", rawStatus: "已揽收", expected: "In Transit" },
    { status: "In Transit", rawStatus: "派送中", expected: "Out for delivery" },
    { status: "Delivered", rawStatus: "已签收", expected: "Delivered" },
    { status: "Fulfilled - LtL processing", rawStatus: "已取消", expected: "Canceled" },
  ];

  for (const entry of cases) {
    const order = toLighthouseOrder({
      found: true,
      shipments: [{
        source: "surpath",
        status: entry.status,
        rawStatus: entry.rawStatus,
        items: [],
        tracking: [],
      }],
    });

    assert.equal(order.shipments[0].status, entry.expected, entry.rawStatus);
  }
});

test("drops non-web tracking links from Lighthouse responses", () => {
  const order = toLighthouseOrder({
    found: true,
    orderName: "WS-#32303",
    shipments: [{
      status: "In Transit",
      items: [],
      tracking: [{
        carrier: "Unknown carrier",
        trackingNumber: "TRACKING",
        trackingUrl: "javascript:alert('unsafe')",
      }],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.equal(order.shipments[0].tracking[0].trackingUrl, null);
});
