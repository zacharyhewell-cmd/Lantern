import { itemDisplayName } from "../items/skuAliases.js";
import { truncateTrackingUpdate } from "../formatters/trackingUpdate.js";
import { toPublicEnglishText } from "./englishText.js";

const UPS_OUT_FOR_DELIVERY = "out for delivery, out for delivery today";
const FEDEX_UNABLE_TO_DELIVER = "shipment exception, unable to deliver";
const UPS_EXCEPTION_UPDATES = new Set([
  "a claim has been issued to the sender for your package. please contact the sender for more information.",
  "ups has returned your package to the sender.",
  "returned, package was returned to the sender",
]);
const UPS_UPDATE_TEXT = new Map([
  ["label created, shipper created a label, ups has not received the package yet.", "Label Created"],
  ["we have your package, arrived at facility", "On the Way, Arrived at Facility"],
  [UPS_OUT_FOR_DELIVERY, "Out for Delivery"],
  ["delivered, delivered", "Delivered"],
  // A null replacement keeps the full carrier description.
  ["delivery attempted, we tried to deliver to the business, but it was closed. a second attempt will be made the next business day.", null],
  ["reschedule delivery requested, we received a request from the receiver to reschedule the delivery.", null],
]);

function publicItem(item) {
  const fallback = String(item?.sku || "").trim() || "Item";
  return {
    name: toPublicEnglishText(itemDisplayName(item), { fallback }),
    quantity: Number(item.quantity || 0),
  };
}

function publicItems(items) {
  return (items ?? [])
    .filter((item) => !/^abox/i.test(String(item.sku ?? "").trim()))
    .map(publicItem);
}

function confirmsOutForDelivery(tracking) {
  const description = tracking.fedEx?.latestEvent?.description ||
    tracking.fedEx?.status || tracking.latestUpdate?.description || "";
  if (tracking.carrier === "UPS" && description.trim().toLowerCase() === UPS_OUT_FOR_DELIVERY) {
    return true;
  }
  return /^(?:(?:shipment status changed to:\s*)?(?:package\s+|on fedex vehicle )?out for delivery[.!]?|(?:包裹)?正在派送[。]?)$/i
    .test(description.trim());
}

function confirmsException({ carrier, latestUpdate }) {
  const description = latestUpdate?.description?.trim().toLowerCase();
  return (carrier === "UPS" && UPS_EXCEPTION_UPDATES.has(description)) ||
    (carrier === "FedEx" && description === FEDEX_UNABLE_TO_DELIVER);
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

  if (shipment.tracking?.some(confirmsException)) {
    return "Exception";
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

function publicUpdateDescription(description, carrier) {
  const english = toPublicEnglishText(description, {
    fallback: "Carrier update received",
  });
  const replacement = carrier === "UPS" ? UPS_UPDATE_TEXT.get(english.toLowerCase()) : undefined;
  return replacement === null ? english : replacement ?? truncateTrackingUpdate(english);
}

function publicLatestUpdate(tracking) {
  if (tracking.fedEx?.latestEvent) {
    return {
      description: publicUpdateDescription(tracking.fedEx.latestEvent.description),
      location: toPublicEnglishText(tracking.fedEx.latestEvent.location),
      time: toPublicEnglishText(tracking.fedEx.latestEvent.scanTime),
    };
  }

  if (tracking.fedEx?.status) {
    return {
      description: publicUpdateDescription(tracking.fedEx.status),
      location: null,
      time: null,
    };
  }

  if (tracking.latestUpdate?.description) {
    return {
      description: publicUpdateDescription(tracking.latestUpdate.description, tracking.carrier),
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
    items: publicItems(shipment.items),
    tracking: (shipment.tracking || []).map(publicTracking),
  };
}

const SHIPMENT_STATUS_RANK = new Map([
  ["Processing", 0],
  ["Waiting for pickup", 1],
  ["In Transit", 2],
  ["Out for delivery", 3],
  ["Exception", 4],
  ["Delivered", 5],
  ["Canceled", 6],
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
    unfulfilledItems: publicItems(summary.unfulfilledItems),
    shipments: sortShipments((summary.shipments || []).map(publicShipment)),
    warnings: [...new Set((summary.warnings || []).map((warning) => (
      toPublicEnglishText(warning, {
        fallback: "Additional shipment information is available.",
      })
    )).filter(Boolean))],
  };
}
