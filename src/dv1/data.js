import { normalizeOrderIdentifier } from "../orderIds.js";
import { ShopifyClient } from "../shopify/client.js";
import { SurpathMcpClient } from "../surpath/client.js";

const DEFAULT_CARTON_SKUS = [
  "ABOX0001",
  "ABOX0002",
  "ABOX0003",
  "ABOX0004",
  "ABOX0005",
  "ABOX0006",
  "ABOX0007",
];

function compact(value) {
  return value == null || value === "" ? null : value;
}

function requestedCartonSkus() {
  const configured = String(process.env.DV1_CARTON_SKUS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_CARTON_SKUS;
}

function planningLines(order) {
  return (order.lineItems?.nodes || [])
    .map((lineItem) => ({
      id: lineItem.id,
      sku: compact(lineItem.sku),
      quantity: Number(lineItem.fulfillableQuantity ?? lineItem.currentQuantity ?? lineItem.quantity ?? 0),
    }))
    .filter((line) => line.sku && line.quantity > 0);
}

function normalizeInventoryRows(rows) {
  return (rows || [])
    .map((row) => ({
      sku: row.sku,
      available: Number(row.availableInventory || 0),
      warehouseId: row.warehouseCode || row.warehouseName || "unknown",
    }))
    .filter((item) => item.sku);
}

export async function loadDv1PlanningData({
  orderNumber,
  shopifyConfig,
  surpathConfig,
  shopifyClient = new ShopifyClient(shopifyConfig),
  surpathClient = new SurpathMcpClient(surpathConfig),
}) {
  const orderIdentifier = normalizeOrderIdentifier(orderNumber);
  if (!orderIdentifier) {
    throw new Error("Enter an order number such as WS-#10001.");
  }

  const shopifyOrders = await shopifyClient.findOrdersForTracking(orderIdentifier);
  if (!shopifyOrders.length) {
    return null;
  }

  const shopifyOrder = shopifyOrders.find((order) => (
    order.name?.toUpperCase() === orderIdentifier.canonical.toUpperCase()
  )) || shopifyOrders[0];
  const lines = planningLines(shopifyOrder);
  const requestedSkus = [...new Set(lines.map((line) => line.sku))];
  const response = await loadInventory(surpathClient, [...requestedSkus, ...requestedCartonSkus()]);
  const inventory = normalizeInventoryRows(response.data);
  const warehouseId = process.env.DV1_DEFAULT_WAREHOUSE || "unknown";

  try {
    return {
      order: {
        orderId: shopifyOrder.id,
        orderNumber: shopifyOrder.name || orderIdentifier.canonical,
        warehouseId,
        lines,
      },
      inventory: {
        warehouseId,
        items: inventory,
      },
      warnings: [
        ...(warehouseId === "unknown" ? ["The planner will use each inventory row's warehouse location."] : []),
      ],
    };
  } finally {
    await surpathClient.close?.();
  }
}

async function loadInventory(surpathClient, skus) {
  try {
    return await surpathClient.querySkuInventory({ skuList: [...new Set(skus)] });
  } catch (error) {
    await surpathClient.close?.();
    throw error;
  }
}
