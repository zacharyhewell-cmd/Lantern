import { detectCarrier } from "../tracking/carriers.js";
import { ltlTrackingUrl } from "../tracking/ltlLinks.js";

function compact(value) {
  return value == null || value === "" ? null : value;
}

function normalizeTrackingInfo(trackingInfo = []) {
  return trackingInfo
    .map((tracking) => {
      const trackingNumber = compact(tracking.number);
      const carrier = detectCarrier({
        company: compact(tracking.company),
        trackingNumber,
        trackingUrl: compact(tracking.url),
      });

      return {
        trackingNumber,
        trackingUrl: carrier === "4PX"
          ? ltlTrackingUrl({ carrier, trackingNumber })
          : compact(tracking.url),
        carrier,
      };
    })
    .filter((tracking) => tracking.trackingNumber || tracking.trackingUrl);
}

function normalizeItems(lineItemsConnection) {
  return (lineItemsConnection?.nodes || []).map((node) => {
    const name = buildLineItemName(node.lineItem) || "Unknown item";
    return {
      lineItemId: compact(node.lineItem?.id),
      name,
      sku: compact(node.lineItem?.sku) || inferSkuFromName(name),
      quantity: node.quantity || 0,
    };
  });
}

function normalizeShipment(fulfillment) {
  const tracking = normalizeTrackingInfo(fulfillment.trackingInfo);
  const rawStatus = fulfillment.status || "UNKNOWN";
  const customerStatus = fulfillment.deliveredAt
    ? "Delivered"
    : tracking.some((item) => item.carrier === "4PX")
      ? "Shipping from China - see tracking"
    : tracking.length > 0
      ? "In Transit"
      : "Waiting for pickup";

  return {
    source: "shopify",
    fulfillmentId: fulfillment.id,
    fulfillmentName: compact(fulfillment.name),
    status: customerStatus,
    rawStatus,
    createdAt: compact(fulfillment.createdAt),
    updatedAt: compact(fulfillment.updatedAt),
    deliveredAt: compact(fulfillment.deliveredAt),
    estimatedDeliveryAt: compact(fulfillment.estimatedDeliveryAt),
    tracking,
    items: normalizeItems(fulfillment.fulfillmentLineItems),
    hasTracking: tracking.length > 0,
  };
}

function splitShipmentByTracking(shipment) {
  if (shipment.tracking.length <= 1) {
    return [shipment];
  }

  return shipment.tracking.map((tracking, index) => ({
    ...shipment,
    fulfillmentName: shipment.fulfillmentName
      ? `${shipment.fulfillmentName}.${index + 1}`
      : shipment.fulfillmentName,
    tracking: [tracking],
  }));
}

function chooseBestOrder(orders, orderIdentifier) {
  if (!orders.length) {
    return null;
  }

  const candidateNames = new Set(orderIdentifier.candidates.map((candidate) => candidate.toUpperCase()));
  return (
    orders.find((order) => candidateNames.has(String(order.name).toUpperCase())) ||
    orders[0]
  );
}

function normalizeOrderItems(lineItemsConnection) {
  return (lineItemsConnection?.nodes || []).map((node) => {
    const name = buildLineItemName(node) || "Unknown item";
    return {
      lineItemId: compact(node.id),
      name,
      sku: compact(node.sku) || inferSkuFromName(name),
      quantity: node.quantity || 0,
      currentQuantity: node.currentQuantity ?? node.quantity ?? 0,
      fulfillableQuantity: node.fulfillableQuantity || 0,
    };
  });
}

function normalizeShippingAddress(address) {
  if (!address) {
    return null;
  }

  return {
    name: compact(address.name),
    company: compact(address.company),
    address1: compact(address.address1),
    address2: compact(address.address2),
    city: compact(address.city),
    provinceCode: compact(address.provinceCode),
    zip: compact(address.zip),
    countryCode: compact(address.countryCode),
    phone: compact(address.phone),
  };
}

function buildLineItemName(lineItem) {
  if (!lineItem) {
    return null;
  }

  const title = compact(lineItem.title);
  const variantTitle = compact(lineItem.variantTitle);
  if (title && variantTitle && variantTitle !== "Default Title") {
    return `${title} - ${variantTitle}`;
  }

  return title || compact(lineItem.name) || compact(lineItem.sku);
}

function inferSkuFromName(name) {
  const match = String(name || "").trim().match(/^([A-Z]{2,}[A-Z0-9]*\d[A-Z0-9]*)(?=$|[\s:—–-])/);
  return match?.[1] || null;
}

function getFulfilledQuantityByLineItem(shipments) {
  const fulfilled = new Map();

  for (const shipment of shipments) {
    for (const item of shipment.items) {
      if (!item.lineItemId) {
        continue;
      }

      fulfilled.set(item.lineItemId, (fulfilled.get(item.lineItemId) || 0) + item.quantity);
    }
  }

  return fulfilled;
}

function normalizeUnfulfilledItems(orderItems, shipments) {
  const fulfilled = getFulfilledQuantityByLineItem(shipments);

  return orderItems
    .map((item) => {
      const remainingByFulfillmentMath = Math.max(item.currentQuantity - (fulfilled.get(item.lineItemId) || 0), 0);
      const remaining = Math.max(item.fulfillableQuantity, remainingByFulfillmentMath);

      return {
        lineItemId: item.lineItemId,
        name: item.name,
        sku: item.sku,
        quantity: remaining,
      };
    })
    .filter((item) => item.quantity > 0);
}

function enrichShipmentItems(shipments, orderItems) {
  const orderItemsById = new Map(
    orderItems
      .filter((item) => item.lineItemId)
      .map((item) => [item.lineItemId, item]),
  );

  return shipments.map((shipment) => ({
    ...shipment,
    items: shipment.items.map((item) => {
      const orderItem = orderItemsById.get(item.lineItemId);
      if (!orderItem) {
        return item;
      }

      return {
        ...item,
        name: orderItem.name || item.name,
        sku: orderItem.sku || item.sku,
      };
    }),
  }));
}

export function normalizeShopifyTracking(orders, orderIdentifier) {
  const warnings = [];

  if (!orders?.length) {
    return {
      found: false,
      requestedOrder: orderIdentifier.raw,
      warnings: [`No Shopify order matched ${orderIdentifier.raw}.`],
      shipments: [],
    };
  }

  if (orders.length > 1) {
    warnings.push(`Multiple Shopify orders matched; using the newest exact or closest match.`);
  }

  const order = chooseBestOrder(orders, orderIdentifier);
  const orderItems = normalizeOrderItems(order.lineItems);
  const shipments = enrichShipmentItems(
    (order.fulfillments || []).map(normalizeShipment).flatMap(splitShipmentByTracking),
    orderItems,
  );
  const unfulfilledItems = normalizeUnfulfilledItems(orderItems, shipments);

  if (order.cancelledAt) {
    warnings.push("Order is canceled in Shopify.");
  }

  if (!shipments.length) {
    warnings.push("No fulfillments found in Shopify yet.");
  } else if (shipments.every((shipment) => !shipment.hasTracking)) {
    warnings.push("Fulfillments exist, but Shopify has no tracking number yet.");
  }

  return {
    found: true,
    source: "shopify",
    requestedOrder: orderIdentifier.raw,
    orderId: order.id,
    orderName: order.name,
    createdAt: compact(order.createdAt),
    cancelledAt: compact(order.cancelledAt),
    closed: Boolean(order.closed),
    closedAt: compact(order.closedAt),
    financialStatus: compact(order.displayFinancialStatus),
    fulfillmentStatus: shipments.length ? summarizeShipmentStatuses(shipments) : "Unfulfilled",
    shippingAddress: normalizeShippingAddress(order.shippingAddress),
    shipments,
    unfulfilledItems,
    warnings,
    rawMatchCount: orders.length,
  };
}

function summarizeShipmentStatuses(shipments) {
  if (shipments.some((shipment) => shipment.status === "In Transit")) {
    return "In Transit";
  }

  if (shipments.length > 0 && shipments.every((shipment) => shipment.status === "Delivered")) {
    return "Delivered";
  }

  if (shipments.length > 0) {
    return "Waiting for pickup";
  }

  return "Unfulfilled";
}
