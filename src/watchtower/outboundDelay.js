import { detectCarrier } from "../tracking/carriers.js";
import { normalizeSurpathStatus } from "../surpath/status.js";
import { businessHoursBetween, businessTimeZoneForWarehouse } from "./businessTime.js";

const WS_ORDER_PATTERN = /^WS-#\d+$/i;
const HOUR_MS = 60 * 60 * 1000;

function compact(value) {
  return value == null || value === "" ? null : value;
}

function parseTime(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function formatIso(value) {
  const time = parseTime(value);
  return time == null ? null : new Date(time).toISOString();
}

function wsOrderNumber(row) {
  const value = compact(row.customerPlatformCode);
  return value && WS_ORDER_PATTERN.test(value) ? value.toUpperCase() : null;
}

function shipmentCode(row) {
  return compact(row.expressNumber) ||
    compact(row.bolCode) ||
    compact(row.wmsOutboundCode) ||
    compact(row.platformCode) ||
    String(row.id || "");
}

function shipmentKey(row) {
  return [
    wsOrderNumber(row),
    shipmentCode(row),
  ].filter(Boolean).join("|");
}

function isDelivered(row) {
  return Boolean(row.deliveredDate) || normalizeSurpathStatus(row.status) === "Delivered";
}

function isCanceled(row) {
  const status = String(row.status || "").trim().toLowerCase();
  return status.includes("canceled") || status.includes("cancelled") || status.includes("已取消");
}

function carrierForRows(rows) {
  const row = rows[0] || {};
  return detectCarrier({
    company: compact(row.carrierName) || compact(row.carrierPlatform) || compact(row.expressFromCode) || compact(row.surpathChannel),
    trackingNumber: compact(row.expressNumber) || compact(row.bolCode),
    trackingUrl: null,
  });
}

function carrierGroup(carrier) {
  return carrier === "FedEx" ? "fedex" : "ltl";
}

function summarizeItems(rows) {
  const quantities = new Map();
  for (const row of rows) {
    const sku = compact(row.sku) || compact(row.name) || "Unknown item";
    quantities.set(sku, (quantities.get(sku) || 0) + Number(row.quantity || 0));
  }

  return [...quantities.entries()]
    .map(([sku, quantity]) => ({ sku, quantity }))
    .filter((item) => item.quantity > 0);
}

function warehouseCode(rows) {
  for (const row of rows) {
    const code = compact(row.warehouseCode) || compact(row.warehouse) || compact(row.warehouseName);
    if (code) {
      return code;
    }
  }

  return null;
}

function destinationState(rows) {
  for (const row of rows) {
    const state = compact(row.state) || compact(row.provinceCode) || compact(row.province);
    if (state) {
      return state;
    }
  }

  return null;
}

function uniqueValues(rows, field) {
  return [...new Set(rows.map((row) => compact(row[field])).filter(Boolean))];
}

function latestTime(rows, field) {
  const values = rows.map((row) => parseTime(row[field])).filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

function baseFinding(rows, { rule, elapsedHours, businessElapsedHours, businessTimeZone, actualOutboundDate, missingOutboundDate }) {
  const first = rows[0];
  const carrier = carrierForRows(rows);
  const code = shipmentCode(first);
  const createTimes = rows.map((row) => parseTime(row.createTime)).filter((value) => value != null);
  const createTime = createTimes.length ? Math.min(...createTimes) : null;

  return {
    rule,
    orderNumber: wsOrderNumber(first),
    shipmentCode: code,
    platformCodes: uniqueValues(rows, "platformCode"),
    referenceCodes: uniqueValues(rows, "referenceCode"),
    trackingNumber: compact(first.expressNumber) || compact(first.bolCode),
    wmsOutboundCode: compact(first.wmsOutboundCode),
    carrier,
    carrierGroup: carrierGroup(carrier),
    status: compact(first.status),
    statusCode: first.statusCode ?? null,
    warehouseCode: warehouseCode(rows),
    businessTimeZone,
    destinationState: destinationState(rows),
    createTime: formatIso(createTime),
    actualOutboundDate: formatIso(actualOutboundDate),
    lastTrackTime: formatIso(latestTime(rows, "lastTrackTime")),
    missingOutboundDate,
    elapsedHours,
    businessElapsedHours,
    elapsedDays: elapsedHours / 24,
    items: summarizeItems(rows),
  };
}

function outboundDelayFindingFromRows(rows, thresholdHours, now = Date.now()) {
  const createTimes = rows.map((row) => parseTime(row.createTime)).filter((value) => value != null);
  const outboundTimes = rows.map((row) => parseTime(row.actualOutboundDate)).filter((value) => value != null);
  if (!createTimes.length || outboundTimes.length) {
    return null;
  }

  const createTime = Math.min(...createTimes);
  const elapsedHours = (now - createTime) / HOUR_MS;
  if (elapsedHours <= thresholdHours) {
    return null;
  }
  const timeZone = businessTimeZoneForWarehouse(warehouseCode(rows));

  return baseFinding(rows, {
    rule: "preship_delay",
    elapsedHours,
    businessElapsedHours: businessHoursBetween(createTime, now, { timeZone }),
    businessTimeZone: timeZone,
    actualOutboundDate: null,
    missingOutboundDate: true,
  });
}

function inTransitDelayFindingFromRows(rows, thresholdHours, now = Date.now()) {
  const outboundTimes = rows.map((row) => parseTime(row.actualOutboundDate)).filter((value) => value != null);
  if (!outboundTimes.length) {
    return null;
  }

  const actualOutboundDate = Math.min(...outboundTimes);
  const elapsedHours = (now - actualOutboundDate) / HOUR_MS;
  if (elapsedHours <= thresholdHours) {
    return null;
  }

  return baseFinding(rows, {
    rule: "in_transit_delay",
    elapsedHours,
    actualOutboundDate,
    missingOutboundDate: false,
  });
}

function groupedFindings(rows, findingFactory) {
  const groups = new Map();

  for (const row of rows || []) {
    const orderNumber = wsOrderNumber(row);
    if (!orderNumber || isDelivered(row) || isCanceled(row)) {
      continue;
    }

    const key = shipmentKey(row);
    if (!key) {
      continue;
    }

    groups.set(key, [...(groups.get(key) || []), row]);
  }

  return [...groups.values()]
    .map(findingFactory)
    .filter(Boolean)
    .sort((left, right) => right.elapsedHours - left.elapsedHours);
}

export function findOutboundDelayFindings(rows, { thresholdHours = 48, now = Date.now() } = {}) {
  return groupedFindings(rows, (records) => outboundDelayFindingFromRows(records, thresholdHours, now));
}

export function findInTransitDelayFindings(rows, { thresholdHours = 120, now = Date.now() } = {}) {
  return groupedFindings(rows, (records) => inTransitDelayFindingFromRows(records, thresholdHours, now));
}

export function groupWatchtowerFindings(findings) {
  const byCarrierGroup = {
    fedex: new Map(),
    ltl: new Map(),
  };

  for (const finding of findings || []) {
    const group = byCarrierGroup[finding.carrierGroup] || byCarrierGroup.ltl;
    const orders = group.get(finding.orderNumber) || [];
    orders.push(finding);
    group.set(finding.orderNumber, orders);
  }

  return Object.fromEntries(
    Object.entries(byCarrierGroup).map(([key, orders]) => [
      key,
      [...orders.entries()]
        .map(([orderNumber, shipments]) => ({
          orderNumber,
          maxElapsedHours: Math.max(...shipments.map((shipment) => shipment.elapsedHours)),
          shipments: shipments.sort((left, right) => right.elapsedHours - left.elapsedHours),
        }))
        .sort((left, right) => right.maxElapsedHours - left.maxElapsedHours),
    ]),
  );
}
