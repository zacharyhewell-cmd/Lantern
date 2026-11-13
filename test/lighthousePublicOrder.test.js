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
      status: "Fulfilled - LtL processing - 待出库",
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
