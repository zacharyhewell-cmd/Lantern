const STATUS_MAP = new Map([
  ["pending", "Unfulfilled"],
  ["shipped - not pickup", "Waiting for pickup"],
  ["shipped - in transit", "In Transit"],
]);

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

export function normalizeSurpathStatus(status) {
  if (!status) {
    return "Unfulfilled";
  }

  const normalized = String(status).trim().toLowerCase();
  if (STATUS_MAP.has(normalized)) {
    return STATUS_MAP.get(normalized);
  }

  if (normalized.includes("已出库-待上网")) {
    return "Waiting for pickup";
  }

  if (
    includesAny(normalized, [
      "delivered",
      "delivery completed",
      "signed",
      "pod",
      "consignee received",
      "已妥投",
      "已签收",
      "已送达",
    ])
  ) {
    return "Delivered";
  }

  if (
    includesAny(normalized, [
      "in transit",
      "out for delivery",
      "picked up",
      "pickup completed",
      "arrived",
      "departed",
      "at terminal",
      "at destination",
      "linehaul",
      "on hand",
      "loaded",
      "unloaded",
      "appointment",
      "scheduled for delivery",
      "delivery scheduled",
      "delayed",
      "exception",
      "运输",
      "转运",
      "派送中",
      "已揽收",
      "已出库",
    ])
  ) {
    return "In Transit";
  }

  if (
    includesAny(normalized, [
      "not pickup",
      "not picked up",
      "waiting for pickup",
      "pickup requested",
      "pickup scheduled",
      "shipment created",
      "manifest",
      "tendered",
      "label created",
      "待揽收",
      "待提货",
    ])
  ) {
    return "Waiting for pickup";
  }

  if (
    includesAny(normalized, [
      "pending",
      "unfulfilled",
      "created",
      "new",
      "待出库",
      "未出库",
    ])
  ) {
    return "Unfulfilled";
  }

  return "Unfulfilled";
}

export function normalizeSurpathShipmentStatus({ status, carrier } = {}) {
  const normalizedStatus = normalizeSurpathStatus(status);
  const normalizedCarrier = String(carrier || "").trim().toLowerCase();

  if (normalizedStatus === "Unfulfilled" && normalizedCarrier === "ltl") {
    return "Fulfilled - LtL processing";
  }

  return normalizedStatus;
}
