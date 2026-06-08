import test from "node:test";
import assert from "node:assert/strict";
import { formatTrackingReply } from "../src/formatters/trackingReply.js";

test("does not show Shopify internal fulfillment update fallback", () => {
  const reply = formatTrackingReply({
    found: true,
    orderName: "WS-#12345",
    shipments: [{
      status: "Waiting for pickup",
      updatedAt: "2026-05-20T12:00:00Z",
      tracking: [],
      items: [{ quantity: 1, sku: "SKU-1", name: "Product" }],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.doesNotMatch(reply, /Last fulfillment update/);
});

test("shows the full shipment item list without truncating", () => {
  const reply = formatTrackingReply({
    found: true,
    orderName: "WS-#30239",
    shipments: [{
      source: "surpath",
      status: "Fulfilled - LtL processing",
      rawStatus: "待出库",
      tracking: [{ carrier: "LTL" }],
      items: [
        { quantity: 1, sku: "SKU-1" },
        { quantity: 1, sku: "SKU-2" },
        { quantity: 1, sku: "SKU-3" },
        { quantity: 1, sku: "SKU-4" },
        { quantity: 1, sku: "SKU-5" },
        { quantity: 1, sku: "SKU-6" },
        { quantity: 1, sku: "SKU-7" },
        { quantity: 1, sku: "SKU-8" },
      ],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.match(reply, /SKU-7/);
  assert.match(reply, /SKU-8/);
  assert.doesNotMatch(reply, /more/);
});

test("uses SKU fallback for V items without a friendly alias", () => {
  const reply = formatTrackingReply({
    found: true,
    orderName: "WS-#12345",
    shipments: [{
      status: "Waiting for pickup",
      tracking: [],
      items: [{ quantity: 2, sku: "VUNMAPPED1A", name: "Very long internal item name" }],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.match(reply, /Items: 2x VUNMAPPED1A/);
  assert.doesNotMatch(reply, /Very long internal item name/);
});

test("uses available names for non-V SKUs and omits Velotric", () => {
  const reply = formatTrackingReply({
    found: true,
    orderName: "WS-#12345",
    shipments: [{
      status: "Waiting for pickup",
      tracking: [],
      items: [
        { quantity: 1, sku: "AACC0037A", name: "Velotric Rear Rack" },
        { quantity: 2, sku: "AACC0099B", name: "Front Basket" },
        { quantity: 3, sku: "AACC0000A" },
      ],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.match(reply, /1x Rear Rack/);
  assert.match(reply, /2x Front Basket/);
  assert.match(reply, /3x AACC0000A/);
  assert.doesNotMatch(reply, /Velotric Rear Rack/);
});

test("uses friendly SKU aliases and ignores final revision letter", () => {
  const reply = formatTrackingReply({
    found: true,
    orderName: "WS-#12345",
    shipments: [{
      status: "Fulfilled - LtL processing",
      tracking: [],
      items: [
        { quantity: 1, sku: "VB010001B" },
        { quantity: 2, sku: "VB010001C" },
        { quantity: 3, sku: "VT200004A" },
      ],
    }],
    unfulfilledItems: [],
    warnings: [],
  });

  assert.match(reply, /1x B1 R Ocean Mist/);
  assert.match(reply, /2x B1 R Ocean Mist/);
  assert.match(reply, /3x Tempo MS L Forest Evergreen/);
  assert.doesNotMatch(reply, /VB010001/);
  assert.doesNotMatch(reply, /VT200004A/);
});
