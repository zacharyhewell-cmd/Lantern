import { itemDisplayName } from "../items/skuAliases.js";
import { toPublicEnglishText } from "./englishText.js";

function publicItem(item) {
  const fallback = String(item?.sku || "").trim() || "Item";
  return {
    name: toPublicEnglishText(itemDisplayName(item), { fallback }),
    quantity: Number(item.quantity || 0),
  };
}

function confirmsOutForDelivery(tracking) {
  const description = tracking.fedEx?.latestEvent?.description ||
    tracking.fedEx?.status || tracking.latestUpdate?.description || "";
  return /^(?:(?:shipment status changed to:\s*)?(?:package\s+|on fedex vehicle )?out for delivery[.!]?|(?:包裹)?正在派送[。]?)$/i
    .test(description.trim());
}

function publicStatus(shipment) {
  const status = toPublicEnglishText(shipment.status, { fallback: "" });
  const rawStatus = toPublicEnglishText(shipment.rawStatus, { fallback: "" });
  const combined = `${status} ${rawStatus}`.toLowerCase();

  if (combined.includes("canceled") || combined.includes("cancelled")) {
    return "Canceled";
  }

  if (combined.includes("delivered") || combined.includes("signed for")) {
    return "Delivered";
  }

  if (shipment.tracking?.some(confirmsOutForDelivery)) {
    return "Out for delivery";
  }

  if (
    combined.includes("waiting for pickup") ||
    combined.includes("awaiting carrier pickup") ||
    combined.includes("awaiting pickup") ||
    combined.includes("awaiting carrier scan") ||
    combined.includes("not picked up") ||
    combined.includes("not pickup") ||
    combined.includes("shipment information sent") ||
    combined.includes("label created")
  ) {
    return "Waiting for pickup";
  }

  if (
    combined.includes("in transit") ||
    combined.includes("out for delivery") ||
    combined.includes("shipping from china") ||
    combined.includes("picked up by carrier") ||
    combined.includes("shipped from warehouse") ||
    combined.includes("customs clearance") ||
    combined.includes("arrived") ||
    combined.includes("departed")
  ) {
    return "In Transit";
  }

  return "Processing";
}

function publicLatestUpdate(tracking) {
  if (tracking.fedEx?.latestEvent) {
    return {
      description: toPublicEnglishText(tracking.fedEx.latestEvent.description, {
        fallback: "Carrier update received",
      }),
      location: toPublicEnglishText(tracking.fedEx.latestEvent.location),
      time: toPublicEnglishText(tracking.fedEx.latestEvent.scanTime),
    };
  }

  if (tracking.fedEx?.status) {
    return {
      description: toPublicEnglishText(tracking.fedEx.status, {
        fallback: "Carrier update received",
      }),
      location: null,
      time: null,
    };
  }

  if (tracking.latestUpdate?.description) {
    return {
      description: toPublicEnglishText(tracking.latestUpdate.description, {
        fallback: "Carrier update received",
      }),
      location: toPublicEnglishText(tracking.latestUpdate.location),
      time: toPublicEnglishText(tracking.latestUpdate.time),
    };
  }

  return null;
}

function publicTrackingUrl(value) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function publicTracking(tracking) {
  const carrier = toPublicEnglishText(tracking.carrier, { fallback: "Carrier" });
  return {
    carrier: tracking.carrierConfidence === "likely"
      ? `${carrier} (likely)`
      : carrier,
    trackingNumber: toPublicEnglishText(tracking.trackingNumber),
    trackingUrl: publicTrackingUrl(tracking.trackingUrl),
    latestUpdate: publicLatestUpdate(tracking),
  };
}

function publicShipment(shipment) {
  return {
    status: publicStatus(shipment),
    deliveredAt: toPublicEnglishText(shipment.deliveredAt),
    estimatedDeliveryAt: toPublicEnglishText(shipment.estimatedDeliveryAt),
    items: (shipment.items || []).map(publicItem),
    tracking: (shipment.tracking || []).map(publicTracking),
  };
}

const SHIPMENT_STATUS_RANK = new Map([
  ["Processing", 0],
  ["Waiting for pickup", 1],
  ["In Transit", 2],
  ["Out for delivery", 3],
  ["Delivered", 4],
  ["Canceled", 5],
]);

function sortShipments(shipments) {
  return shipments
    .map((shipment, index) => ({ shipment, index }))
    .sort((left, right) => (
      (SHIPMENT_STATUS_RANK.get(left.shipment.status) ?? 2) -
        (SHIPMENT_STATUS_RANK.get(right.shipment.status) ?? 2) ||
      left.index - right.index
    ))
    .map(({ shipment }) => shipment);
}

export function toLighthouseOrder(summary) {
  const requestedOrder = toPublicEnglishText(summary.requestedOrder);
  return {
    found: Boolean(summary.found),
    orderNumber: toPublicEnglishText(summary.orderName, { fallback: requestedOrder }),
    cancelledAt: toPublicEnglishText(summary.cancelledAt),
    unfulfilledItems: (summary.unfulfilledItems || []).map(publicItem),
    shipments: sortShipments((summary.shipments || []).map(publicShipment)),
    warnings: [...new Set((summary.warnings || []).map((warning) => (
      toPublicEnglishText(warning, {
        fallback: "Additional shipment information is available.",
      })
    )).filter(Boolean))],
  };
}
