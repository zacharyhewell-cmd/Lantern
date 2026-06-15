import { itemDisplayName } from "../items/skuAliases.js";

function formatDateTime(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Los_Angeles",
  }).format(date);
}

function formatDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "America/Los_Angeles",
  }).format(date);
}

function formatLatestUpdate({ description, location, time }) {
  const locationText = location ? `, ${location}` : "";
  const timeText = time ? `, ${formatDateTime(time)}` : "";
  return `${description}${locationText}${timeText}`;
}

function isLtlShipment(shipment) {
  return shipment.source === "surpath" &&
    !shipment.tracking?.some((tracking) => tracking.carrier === "FedEx");
}

function formatShipmentStatus(shipment) {
  if (isLtlShipment(shipment) && shipment.rawStatus) {
    return `${shipment.status} - ${shipment.rawStatus}`;
  }

  return shipment.status;
}

function formatCarrier(tracking) {
  return tracking.carrierConfidence === "likely"
    ? `${tracking.carrier} (likely)`
    : tracking.carrier;
}

function formatTrackingNumber(tracking) {
  if (!tracking.trackingNumber) {
    return null;
  }

  if (tracking.trackingUrl) {
    return `[${tracking.trackingNumber}](${tracking.trackingUrl})`;
  }

  return tracking.trackingNumber;
}

function formatTrackingLatestUpdate(tracking) {
  if (tracking.fedEx?.latestEvent) {
    return `Latest update: ${formatLatestUpdate({
      description: tracking.fedEx.latestEvent.description,
      location: tracking.fedEx.latestEvent.location,
      time: tracking.fedEx.latestEvent.scanTime,
    })}`;
  }

  if (tracking.fedEx?.status) {
    return `Latest update: ${tracking.fedEx.status}`;
  }

  if (tracking.latestUpdate?.description) {
    return `Latest update: ${formatLatestUpdate(tracking.latestUpdate)}`;
  }

  return null;
}

function formatShipment(shipment, index, total) {
  const lines = [];
  const label = total > 1 ? `Status ${index + 1}` : "Status";
  lines.push(`${label}: ${formatShipmentStatus(shipment)}`);

  if (shipment.items.length) {
    lines.push(`Items: ${formatItems(shipment.items)}`);
  }

  if (shipment.deliveredAt) {
    lines.push(`Delivered: ${formatDateTime(shipment.deliveredAt)}`);
  } else if (shipment.estimatedDeliveryAt) {
    lines.push(`Estimated delivery: ${formatDate(shipment.estimatedDeliveryAt)}`);
  }

  if (shipment.tracking.length) {
    let hasTrackingNumber = false;
    for (const tracking of shipment.tracking) {
      lines.push(`Carrier: ${formatCarrier(tracking)}`);
      const trackingNumber = formatTrackingNumber(tracking);
      if (trackingNumber) {
        hasTrackingNumber = true;
        lines.push(`Tracking: ${trackingNumber}`);
      }
      const latestUpdate = formatTrackingLatestUpdate(tracking);
      if (latestUpdate) {
        lines.push(latestUpdate);
      }
    }
    if (!hasTrackingNumber) {
      lines.push("Tracking: Not available yet");
    }
  } else {
    lines.push("Tracking: Not available yet");
  }

  return lines.join("\n");
}

function formatItems(items) {
  return items
    .map((item) => `${item.quantity}x ${itemDisplayName(item)}`)
    .join(", ");
}

const SHIPMENT_STATUS_RANK = new Map([
  ["Unfulfilled", 0],
  ["Fulfilled - LtL processing", 1],
  ["Waiting for pickup", 1],
  ["In Transit", 2],
  ["Delivered", 3],
]);

function shipmentStatusRank(shipment) {
  return SHIPMENT_STATUS_RANK.get(shipment.status) ?? 2;
}

function sortShipmentsForReply(shipments = []) {
  return shipments
    .map((shipment, index) => ({ shipment, index }))
    .sort((left, right) => (
      shipmentStatusRank(left.shipment) - shipmentStatusRank(right.shipment) ||
      left.index - right.index
    ))
    .map(({ shipment }) => shipment);
}

export function formatTrackingReply(summary) {
  if (!summary.found) {
    return `I could not find order ${summary.requestedOrder} in Shopify.`;
  }

  const lines = [
    `Order ${summary.orderName}`,
  ];

  if (summary.cancelledAt) {
    lines.push(`Canceled: ${formatDateTime(summary.cancelledAt)}`);
  }

  if (summary.unfulfilledItems?.length) {
    lines.push("");
    lines.push("Unfulfilled items:");
    lines.push(formatItems(summary.unfulfilledItems));
  }

  const sortedShipments = sortShipmentsForReply(summary.shipments);
  if (sortedShipments.length) {
    lines.push("");
    lines.push(
      sortedShipments
        .map((shipment, index) => formatShipment(shipment, index, sortedShipments.length))
        .join("\n\n"),
    );
  }

  if (summary.warnings.length) {
    lines.push("");
    lines.push(summary.warnings.map((warning) => `Note: ${warning}`).join("\n"));
  }

  return lines.join("\n");
}
