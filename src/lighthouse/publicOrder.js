import { itemDisplayName } from "../items/skuAliases.js";

function publicItem(item) {
  return {
    name: itemDisplayName(item),
    quantity: Number(item.quantity || 0),
  };
}

function isLtlShipment(shipment) {
  return shipment.source === "surpath" &&
    !shipment.tracking?.some((tracking) => tracking.carrier === "FedEx");
}

function publicStatus(shipment) {
  return isLtlShipment(shipment) && shipment.rawStatus
    ? `${shipment.status} - ${shipment.rawStatus}`
    : shipment.status;
}

function publicLatestUpdate(tracking) {
  if (tracking.fedEx?.latestEvent) {
    return {
      description: tracking.fedEx.latestEvent.description || null,
      location: tracking.fedEx.latestEvent.location || null,
      time: tracking.fedEx.latestEvent.scanTime || null,
    };
  }

  if (tracking.fedEx?.status) {
    return {
      description: tracking.fedEx.status,
      location: null,
      time: null,
    };
  }

  if (tracking.latestUpdate?.description) {
    return {
      description: tracking.latestUpdate.description,
      location: tracking.latestUpdate.location || null,
      time: tracking.latestUpdate.time || null,
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
  return {
    carrier: tracking.carrierConfidence === "likely"
      ? `${tracking.carrier} (likely)`
      : tracking.carrier,
    trackingNumber: tracking.trackingNumber || null,
    trackingUrl: publicTrackingUrl(tracking.trackingUrl),
    latestUpdate: publicLatestUpdate(tracking),
  };
}

function publicShipment(shipment) {
  return {
    status: publicStatus(shipment),
    deliveredAt: shipment.deliveredAt || null,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt || null,
    items: (shipment.items || []).map(publicItem),
    tracking: (shipment.tracking || []).map(publicTracking),
  };
}

const SHIPMENT_STATUS_RANK = new Map([
  ["Unfulfilled", 0],
  ["Fulfilled - LtL processing", 1],
  ["Waiting for pickup", 1],
  ["Shipping from China - see tracking", 1],
  ["In Transit", 2],
  ["Delivered", 3],
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
  return {
    found: Boolean(summary.found),
    orderNumber: summary.orderName || summary.requestedOrder || null,
    cancelledAt: summary.cancelledAt || null,
    unfulfilledItems: (summary.unfulfilledItems || []).map(publicItem),
    shipments: sortShipments(summary.shipments || []).map(publicShipment),
    warnings: [...(summary.warnings || [])],
  };
}
