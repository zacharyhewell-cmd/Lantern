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
      if (tracking.fedEx?.latestEvent) {
        lines.push(`Latest update: ${formatLatestUpdate({
          description: tracking.fedEx.latestEvent.description,
          location: tracking.fedEx.latestEvent.location,
          time: tracking.fedEx.latestEvent.scanTime,
        })}`);
      } else if (tracking.fedEx?.status) {
        lines.push(`Latest update: ${tracking.fedEx.status}`);
      } else if (tracking.latestUpdate?.description) {
        lines.push(`Latest update: ${formatLatestUpdate(tracking.latestUpdate)}`);
      }
      if (tracking.trackingNumber) {
        hasTrackingNumber = true;
        lines.push(`Tracking: ${tracking.trackingNumber}`);
      }
      if (tracking.trackingUrl) {
        lines.push(`Link: ${tracking.trackingUrl}`);
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

  if (summary.shipments.length) {
    lines.push("");
    lines.push(
      summary.shipments
        .map((shipment, index) => formatShipment(shipment, index, summary.shipments.length))
        .join("\n\n"),
    );
  }

  if (summary.unfulfilledItems?.length) {
    lines.push("");
    lines.push("Unfulfilled items:");
    lines.push(formatItems(summary.unfulfilledItems));
  }

  if (summary.warnings.length) {
    lines.push("");
    lines.push(summary.warnings.map((warning) => `Note: ${warning}`).join("\n"));
  }

  return lines.join("\n");
}
