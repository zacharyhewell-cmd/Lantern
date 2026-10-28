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
  assert.deepEqual(result.order.lines, [{ id: "line-1", sku: "AACC0120A", quantity: 2 }]);
  assert.equal(result.inventory.items[0].warehouseId, "LA-SPI1");
  assert.ok(calls[0].skuList.includes("ABOX0003"));
});
