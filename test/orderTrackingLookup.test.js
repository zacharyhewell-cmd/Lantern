import test from "node:test";
import assert from "node:assert/strict";
import { lookupOrderTracking } from "../src/tracking/surpathTracking.js";
import { buildSurpathTrackingReply } from "../src/tracking/surpathTrackingReply.js";

const trackingSummary = {
  found: true,
  source: "shopify",
  requestedOrder: "32303",
  orderName: "WS-#32303",
  shippingAddress: { zip: "97214" },
  shipments: [{
    source: "shopify",
    status: "In Transit",
    rawStatus: "SUCCESS",
    deliveredAt: null,
    estimatedDeliveryAt: null,
    tracking: [{
      carrier: "FedEx",
      trackingNumber: "872018610504",
      trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=872018610504",
    }],
    items: [{ quantity: 1, sku: "AACC0037A", name: "Velotric Rear Rack" }],
  }],
  unfulfilledItems: [],
  warnings: [],
};

function fallbackDependencies() {
  return {
    createSurpathClient: () => ({
      isConfigured: () => false,
    }),
    loadShopify: async () => trackingSummary,
    enrichWithFedEx: async (summary) => summary,
  };
}

test("returns a structured tracking summary without applying Lantern formatting", async () => {
  const summary = await lookupOrderTracking({
    orderText: "32303",
    shopifyConfig: {},
    surpathConfig: {},
    fedExConfig: {},
  }, fallbackDependencies());

  assert.deepEqual(summary, {
    ...trackingSummary,
    verification: { shippingPostalCode: "97214" },
  });
});

test("returns the merged Surpath-first summary and closes the lookup client", async () => {
  let closed = false;
  const summary = await lookupOrderTracking({
    orderText: "32303",
    shopifyConfig: {},
    surpathConfig: {},
    fedExConfig: {},
  }, {
    createSurpathClient: () => ({
      isConfigured: () => true,
      async queryOutboundOrders() {
        return {
          data: [{
            id: "shipment-1",
            customerPlatformCode: "WS-#32303",
            platformCode: "OT-32303",
            expressNumber: "872018610504",
            carrierName: "FedEx",
            status: "Shipped - In Transit",
            sku: "AACC0037A",
            name: "Velotric Rear Rack",
            quantity: 1,
          }],
        };
      },
      async close() {
        closed = true;
      },
    }),
    loadShopify: async () => trackingSummary,
    enrichWithFedEx: async (value) => value,
  });

  assert.equal(summary.source, "surpath");
  assert.equal(summary.orderName, "WS-#32303");
  assert.equal(summary.shipments.length, 1);
  assert.equal(summary.shipments[0].status, "In Transit");
  assert.equal(summary.shipments[0].tracking[0].trackingNumber, "872018610504");
  assert.deepEqual(summary.verification, { shippingPostalCode: "97214" });
  assert.equal(closed, true);
});

test("keeps Lantern's existing text reply as a wrapper around the structured lookup", async () => {
  const reply = await buildSurpathTrackingReply({
    orderText: "32303",
    shopifyConfig: {},
    surpathConfig: {},
    fedExConfig: {},
  }, fallbackDependencies());

  assert.equal(reply, [
    "Order WS-#32303",
    "",
    "Status: In Transit",
    "Items: 1x Rear Rack",
    "Carrier: FedEx",
    "Tracking: [872018610504](https://www.fedex.com/fedextrack/?trknbr=872018610504)",
  ].join("\n"));
});

test("keeps the existing missing-order-number guidance in the Lantern wrapper", async () => {
  assert.equal(await lookupOrderTracking({ orderText: "" }), null);
  assert.equal(
    await buildSurpathTrackingReply({ orderText: "" }),
    "Please include an order number like WS-12345 or 12345.",
  );
});
