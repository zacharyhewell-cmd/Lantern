import assert from "node:assert/strict";
import test from "node:test";
import { loadDv1PlanningData } from "../src/dv1/data.js";

test("DV1 planning data queries Shopify order lines and Surpath inventory", async () => {
  const calls = [];
  const result = await loadDv1PlanningData({
    orderNumber: "WS-#10001",
    shopifyConfig: {},
    surpathConfig: {},
    shopifyClient: {
      async findOrdersForTracking() {
        return [{
          id: "shopify-order",
          name: "WS-#10001",
          shippingAddress: {
            address1: "1 Main St",
            city: "Hoschton",
            provinceCode: "GA",
            zip: "30548",
            countryCode: "US",
          },
          lineItems: {
            nodes: [{ id: "line-1", sku: "AACC0120A", quantity: 2, fulfillableQuantity: 2 }],
          },
        }];
      },
    },
    surpathClient: {
      async querySkuInventory(arguments_) {
        calls.push(arguments_);
        return {
          data: [
            { sku: "AACC0120A", availableInventory: 2, warehouseCode: "LA-SPI1" },
            { sku: "ABOX0003", availableInventory: 1, warehouseCode: "LA-SPI1" },
          ],
        };
      },
      async close() {},
    },
  });

  assert.equal(result.order.orderNumber, "WS-#10001");
  assert.deepEqual(result.order.destination, {
    name: null,
    company: null,
    address1: "1 Main St",
    address2: null,
    city: "Hoschton",
    provinceCode: "GA",
    postalCode: "30548",
    countryCode: "US",
    phone: null,
  });
  assert.deepEqual(result.order.lines, [{ id: "line-1", sku: "AACC0120A", quantity: 2 }]);
  assert.equal(result.inventory.items[0].warehouseId, "LA-SPI1");
  assert.ok(calls[0].skuList.includes("ABOX0003"));
});

test("DV1 accepts exact aliases and rejects unrelated, ambiguous, and incomplete Shopify results", async () => {
  const complete = (name) => ({ name, lineItems: { nodes: [], pageInfo: { hasNextPage: false } } });
  let inventoryCalls = 0;
  const load = (orders) => loadDv1PlanningData({
    orderNumber: "10001",
    shopifyClient: { findOrdersForTracking: async () => orders },
    surpathClient: { querySkuInventory: async () => { inventoryCalls += 1; return { data: [] }; } },
  });

  assert.equal(await load([complete("WS-#100010")]), null);
  await assert.rejects(load([complete("WS-#10001"), complete("#10001")]), /More than one Shopify order/);
  await assert.rejects(load([{
    ...complete("WS-#10001"),
    lineItems: { nodes: [], pageInfo: { hasNextPage: true } },
  }]), /incomplete line-item list/);
  assert.equal(inventoryCalls, 0);
  assert.equal((await load([complete("WS-#100010"), complete("WS-#10001")])).order.orderNumber, "WS-#10001");
  assert.equal(inventoryCalls, 1);
});
