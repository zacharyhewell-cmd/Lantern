import { normalizeSurpathShipmentStatus } from "./status.js";
import { detectCarrier } from "../tracking/carriers.js";
import { ltlTrackingUrl } from "../tracking/ltlLinks.js";

function compact(value) {
  return value == null || value === "" ? null : value;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return compact(value);
}

function fedExTrackingUrl(trackingNumber) {
  return trackingNumber ? `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}` : null;
}

function trackingNumberForRecord(record) {
  return compact(record.expressNumber) || compact(record.bolCode);
}

function trackingKey(record) {
  return trackingNumberForRecord(record) ||
    compact(record.wmsOutboundCode) ||
    compact(record.platformCode) ||
    String(record.id);
}

function chooseShipmentStatus(records, carrier) {
  const statuses = records.map((record) => normalizeSurpathShipmentStatus({ status: record.status, carrier }));
  if (statuses.includes("In Transit")) return "In Transit";
  if (statuses.includes("Waiting for pickup")) return "Waiting for pickup";
  if (statuses.includes("Fulfilled - LtL processing")) return "Fulfilled - LtL processing";
  if (statuses.length && statuses.every((status) => status === "Delivered")) return "Delivered";
  return "Unfulfilled";
}

function normalizeItems(records) {
  const itemsBySku = new Map();
  for (const record of records) {
    const sku = compact(record.sku);
    const name = compact(record.name) || sku || "Unknown item";
    const key = sku || name;
    const existing = itemsBySku.get(key) || { name, sku, quantity: 0 };
    existing.quantity += Number(record.quantity || 0);
    itemsBySku.set(key, existing);
  }

  return [...itemsBySku.values()].filter((item) => item.quantity > 0);
}

function latestRecord(records) {
  return [...records].sort((left, right) => {
    const leftTime = Date.parse(left.lastTrackTime || "") || left.deliveredDate || left.pickupDate || left.actualOutboundDate || 0;
    const rightTime = Date.parse(right.lastTrackTime || "") || right.deliveredDate || right.pickupDate || right.actualOutboundDate || 0;
    return rightTime - leftTime;
  })[0];
}

function parseLastTrack(lastTrack) {
  const value = compact(lastTrack);
  if (!value) {
    return null;
  }

  const match = value.match(/^\[([^\]]+)]\s*(.+)$/);
  if (match) {
    return {
      location: match[1],
      description: match[2],
    };
  }

  return {
    location: null,
    description: value,
  };
}

function normalizeShipment(records) {
  const newest = latestRecord(records);
  const trackingNumber = trackingNumberForRecord(newest);
  const carrier = detectCarrier({
    company: compact(newest.carrierName) || compact(newest.carrierPlatform) || compact(newest.expressFromCode) || compact(newest.surpathChannel),
    trackingNumber,
    trackingUrl: null,
  });
  const latestUpdate = parseLastTrack(newest.lastTrack);
  if (latestUpdate) {
    latestUpdate.time = toIsoDate(newest.lastTrackTime);
  }
  const normalizedStatus = chooseShipmentStatus(records, carrier);
  const status = carrier === "4PX" && trackingNumber && normalizedStatus !== "Delivered"
    ? "Shipping from China - see tracking"
    : normalizedStatus;
  const tracking = {
    carrier,
    carrierConfidence: trackingNumber ? "confirmed" : "likely",
    trackingNumber,
    trackingUrl: carrier === "FedEx"
      ? fedExTrackingUrl(trackingNumber)
      : ltlTrackingUrl({ carrier, trackingNumber, bolCode: newest.bolCode }),
    bolCode: compact(newest.bolCode),
    latestUpdate,
  };

  return {
    source: "surpath",
    status,
    rawStatus: compact(newest.status),
    createdAt: toIsoDate(newest.createTime),
    deliveredAt: status === "Delivered" ? toIsoDate(newest.deliveredDate) : null,
    estimatedDeliveryAt: null,
    warehouseCode: compact(newest.warehouseCode),
    tracking: trackingNumber || carrier !== "Unknown carrier" || latestUpdate ? [tracking] : [],
    items: normalizeItems(records),
    hasTracking: Boolean(trackingNumber),
  };
}

export function normalizeSurpathRows(rows, { orderName, requestedOrder, warnings = [] } = {}) {
  if (!rows?.length) {
    return {
      found: false,
      requestedOrder,
      orderName: orderName || requestedOrder,
      shipments: [],
      unfulfilledItems: [],
      warnings,
    };
  }

  const groups = new Map();
  for (const row of rows) {
    const key = trackingKey(row);
    const records = groups.get(key) || [];
    records.push(row);
    groups.set(key, records);
  }

  return {
    found: true,
    source: "surpath",
    requestedOrder,
    orderName: orderName || requestedOrder,
    shipments: [...groups.values()].map(normalizeShipment),
    unfulfilledItems: [],
    warnings,
  };
}

export function exactRowsForTracking(response, trackingNumber) {
  return (response?.data || []).filter((row) => (
    row.expressNumber === trackingNumber ||
    row.bolCode === trackingNumber
  ));
}
