import { groupWatchtowerFindings } from "../watchtower/outboundDelay.js";

function formatHours(hours) {
  return `${hours.toFixed(1)}h`;
}

function formatDateTime(value) {
  if (!value) {
    return "unknown";
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

function formatItems(items) {
  if (!items?.length) {
    return "Items: unknown";
  }

  return `Items: ${items.map((item) => `${item.quantity}x ${item.sku}`).join(", ")}`;
}

function formatShipment(finding) {
  const lines = [
    `  Shipment: ${finding.shipmentCode}`,
    `  Delay: ${formatHours(finding.elapsedHours)} from Surpath create to outbound`,
    `  Carrier: ${finding.carrier}`,
    `  Status: ${finding.status || "unknown"}`,
    `  Created: ${formatDateTime(finding.createTime)}`,
    `  Outbound: ${formatDateTime(finding.actualOutboundDate)}`,
    `  ${formatItems(finding.items)}`,
  ];

  if (finding.trackingNumber && finding.trackingNumber !== finding.shipmentCode) {
    lines.splice(1, 0, `  Tracking: ${finding.trackingNumber}`);
  }

  if (finding.wmsOutboundCode && finding.wmsOutboundCode !== finding.shipmentCode) {
    lines.splice(1, 0, `  WMS: ${finding.wmsOutboundCode}`);
  }

  return lines.join("\n");
}

function formatOrder(order) {
  return [
    `${order.orderNumber} - worst delay ${formatHours(order.maxElapsedHours)}`,
    ...order.shipments.map(formatShipment),
  ].join("\n");
}

function formatSection(title, orders) {
  if (!orders.length) {
    return `${title}\nNone`;
  }

  return [
    title,
    ...orders.map(formatOrder),
  ].join("\n\n");
}

export function formatWatchtowerOutboundDelayReport(findings, { thresholdHours = 72 } = {}) {
  const grouped = groupWatchtowerFindings(findings);
  const total = (findings || []).length;

  return [
    `Watchtower: outbound delay > ${thresholdHours}h`,
    `Flagged shipments: ${total}`,
    "",
    formatSection("FedEx", grouped.fedex),
    "",
    formatSection("LTL / other carriers", grouped.ltl),
  ].join("\n");
}

