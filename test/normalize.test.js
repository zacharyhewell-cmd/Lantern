import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOrderIdentifier } from "../src/orderIds.js";
import { normalizeShopifyTracking } from "../src/shopify/normalize.js";
import { formatTrackingReply } from "../src/formatters/trackingReply.js";

const orderIdentifier = normalizeOrderIdentifier("WS-#12345");

test("normalizes multi-fulfillment tracking", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/1",
      name: "WS-#12345",
      displayFulfillmentStatus: "PARTIALLY_FULFILLED",
      lineItems: {
        nodes: [
          { id: "li1", name: "Bike", sku: "BIKE-1", quantity: 1, fulfillableQuantity: 0 },
          { id: "li2", name: "Accessory", sku: "ACC-1", quantity: 3, fulfillableQuantity: 1 },
        ],
      },
      fulfillments: [
        {
          id: "f1",
          name: "#12345.1",
          status: "SUCCESS",
          estimatedDeliveryAt: "2026-05-26T03:00:00Z",
          updatedAt: "2026-05-20T15:00:00Z",
          trackingInfo: [{ company: "UPS", number: "1Z999", url: "https://example.com/1Z999" }],
          fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: "li1", name: "Bike", sku: "BIKE-1" } }] },
        },
        {
          id: "f2",
          name: "#12345.2",
          status: "OPEN",
          updatedAt: "2026-05-20T16:00:00Z",
          trackingInfo: [],
          fulfillmentLineItems: { nodes: [{ quantity: 2, lineItem: { id: "li2", name: "Accessory", sku: "ACC-1" } }] },
        },
      ],
    },
  ], orderIdentifier);

  assert.equal(summary.found, true);
  assert.equal(summary.fulfillmentStatus, "In Transit");
  assert.equal(summary.shipments.length, 2);
  assert.equal(summary.shipments[0].status, "In Transit");
  assert.equal(summary.shipments[0].rawStatus, "SUCCESS");
  assert.equal(summary.shipments[1].status, "Waiting for pickup");
  assert.equal(summary.shipments[0].tracking[0].trackingNumber, "1Z999");
  assert.deepEqual(summary.unfulfilledItems, [{
    lineItemId: "li2",
    name: "Accessory",
    sku: "ACC-1",
    quantity: 1,
  }]);

  const reply = formatTrackingReply(summary);
  assert.doesNotMatch(reply, /Shopify fulfillment:/);
  assert.match(reply, /Status 1: Waiting for pickup/);
  assert.match(reply, /Estimated delivery: May 25, 2026/);
  assert.doesNotMatch(reply, /Estimated delivery: .*PM/);
  assert.match(reply, /Status 2: In Transit/);
  assert.match(reply, /Tracking: Not available yet/);
  assert.match(reply, /Unfulfilled items:\n1x Accessory/);
});

test("splits multiple tracking numbers into separate report shipments", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/4",
      name: "WS-#12345",
      lineItems: {
        nodes: [{ id: "li1", name: "Bike", sku: "BIKE-1", quantity: 1, fulfillableQuantity: 0 }],
      },
      fulfillments: [
        {
          id: "f1",
          status: "SUCCESS",
          trackingInfo: [
            { company: "FedEx", number: "111111111111", url: "https://fedex.com/1" },
            { company: "FedEx", number: "222222222222", url: "https://fedex.com/2" },
          ],
          fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: "li1", name: "Bike", sku: "BIKE-1" } }] },
        },
      ],
    },
  ], orderIdentifier);

  assert.equal(summary.shipments.length, 2);
  assert.equal(summary.shipments[0].tracking[0].trackingNumber, "111111111111");
  assert.equal(summary.shipments[1].tracking[0].trackingNumber, "222222222222");

  const reply = formatTrackingReply(summary);
  assert.match(reply, /Status 1: In Transit/);
  assert.match(reply, /Tracking: \[111111111111]\(https:\/\/fedex\.com\/1\)/);
  assert.match(reply, /Status 2: In Transit/);
  assert.match(reply, /Tracking: \[222222222222]\(https:\/\/fedex\.com\/2\)/);
});

test("summarizes no fulfillments as unfulfilled", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/2",
      name: "WS-#12345",
      displayFulfillmentStatus: "UNFULFILLED",
      lineItems: {
        nodes: [{ id: "li1", name: "Bike", sku: "BIKE-1", quantity: 1, fulfillableQuantity: 1 }],
      },
      fulfillments: [],
    },
  ], orderIdentifier);

  assert.equal(summary.fulfillmentStatus, "Unfulfilled");
  assert.equal(summary.shipments.length, 0);
  assert.deepEqual(summary.unfulfilledItems, [{
    lineItemId: "li1",
    name: "Bike",
    sku: "BIKE-1",
    quantity: 1,
  }]);
  assert.doesNotMatch(formatTrackingReply(summary), /Shopify fulfillment:/);
  assert.match(formatTrackingReply(summary), /Unfulfilled items:\n1x Bike/);
});

test("does not report removed Shopify line items as unfulfilled", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/5",
      name: "WS-#12345",
      displayFulfillmentStatus: "FULFILLED",
      lineItems: {
        nodes: [
          { id: "li1", name: "Removed Bike", sku: "BIKE-REMOVED", quantity: 1, currentQuantity: 0, fulfillableQuantity: 0 },
          { id: "li2", name: "Active Bike", sku: "BIKE-ACTIVE", quantity: 1, currentQuantity: 1, fulfillableQuantity: 1 },
        ],
      },
      fulfillments: [],
    },
  ], orderIdentifier);

  assert.deepEqual(summary.unfulfilledItems, [{
    lineItemId: "li2",
    name: "Active Bike",
    sku: "BIKE-ACTIVE",
    quantity: 1,
  }]);
});

test("infers SKU from custom Shopify item name when SKU field is blank", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/6",
      name: "WS-#12345",
      displayFulfillmentStatus: "UNFULFILLED",
      lineItems: {
        nodes: [
          { id: "li1", name: "SDM10304B - DM Cassette", sku: null, quantity: 1, currentQuantity: 1, fulfillableQuantity: 1 },
          { id: "li2", name: "DM Rear Derailleur", sku: null, quantity: 1, currentQuantity: 1, fulfillableQuantity: 1 },
        ],
      },
      fulfillments: [],
    },
  ], orderIdentifier);

  assert.deepEqual(summary.unfulfilledItems, [
    {
      lineItemId: "li1",
      name: "SDM10304B - DM Cassette",
      sku: "SDM10304B",
      quantity: 1,
    },
    {
      lineItemId: "li2",
      name: "DM Rear Derailleur",
      sku: null,
      quantity: 1,
    },
  ]);
});

test("summarizes delivered shipments as delivered", () => {
  const summary = normalizeShopifyTracking([
    {
      id: "gid://shopify/Order/3",
      name: "WS-#12345",
      displayFulfillmentStatus: "FULFILLED",
      lineItems: {
        nodes: [{ id: "li1", name: "Bike", sku: "BIKE-1", quantity: 1, fulfillableQuantity: 0 }],
      },
      fulfillments: [
        {
          id: "f1",
          status: "SUCCESS",
          deliveredAt: "2026-05-20T15:00:00Z",
          trackingInfo: [{ company: "FedEx", number: "872031354189", url: "https://fedex.com/track" }],
          fulfillmentLineItems: { nodes: [{ quantity: 1, lineItem: { id: "li1", name: "Bike", sku: "BIKE-1" } }] },
        },
      ],
    },
  ], orderIdentifier);

  assert.equal(summary.fulfillmentStatus, "Delivered");
  assert.equal(summary.shipments[0].status, "Delivered");
});

test("returns not found summary", () => {
  const summary = normalizeShopifyTracking([], orderIdentifier);
  assert.equal(summary.found, false);
  assert.match(formatTrackingReply(summary), /could not find order WS-#12345/);
});
