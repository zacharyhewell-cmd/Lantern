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

function normalizeShippingAddress(address) {
  if (!address) return undefined;
  return {
    name: compact(address.name),
    company: compact(address.company),
    address1: compact(address.address1),
    address2: compact(address.address2),
    city: compact(address.city),
    provinceCode: compact(address.provinceCode),
    postalCode: compact(address.zip),
    countryCode: compact(address.countryCode),
    phone: compact(address.phone),
  };
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
  const candidateNames = new Set(orderIdentifier.candidates.map((name) => name.toUpperCase()));
  const matches = shopifyOrders.filter((order) => candidateNames.has(order.name?.trim().toUpperCase()));
  if (!matches.length) return null;
  if (matches.length > 1) {
    throw new Error(`More than one Shopify order matches ${orderIdentifier.orderCanonical}. Resolve the order number before planning.`);
  }

  const [shopifyOrder] = matches;
  const lineItems = shopifyOrder.lineItems;
  if (!Array.isArray(lineItems?.nodes) ||
      lineItems.pageInfo?.hasNextPage ||
      (lineItems.pageInfo?.hasNextPage !== false && lineItems.nodes.length >= 250)) {
    throw new Error(`Shopify returned an incomplete line-item list for ${shopifyOrder.name}. DV1 cannot plan this order.`);
  }
  const lines = planningLines(shopifyOrder);
  const requestedSkus = [...new Set([...lines.map((line) => line.sku), ...requestedCartonSkus()])];
  const warehouseId = process.env.DV1_DEFAULT_WAREHOUSE || "unknown";

  try {
    const response = await surpathClient.querySkuInventory({ skuList: requestedSkus });
    const inventory = normalizeInventoryRows(response.data);
    return {
      order: {
        orderId: shopifyOrder.id,
        orderNumber: shopifyOrder.name || orderIdentifier.canonical,
        warehouseId,
        destination: normalizeShippingAddress(shopifyOrder.shippingAddress),
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
