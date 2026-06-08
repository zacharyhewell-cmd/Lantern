function compact(value) {
  return value == null || value === "" ? null : value;
}

function firstTrackResult(response) {
  return response?.output?.completeTrackResults?.[0]?.trackResults?.[0] || null;
}

function normalizeAddress(address = {}) {
  return [
    compact(address.city),
    compact(address.stateOrProvinceCode),
    compact(address.countryCode),
  ].filter(Boolean).join(", ");
}

function normalizeEvent(event = {}) {
  if (!event) {
    return null;
  }

  const description = compact(event.eventDescription) || compact(event.derivedStatus) || compact(event.eventType);
  if (!description) {
    return null;
  }

  return {
    description,
    scanTime: compact(event.date),
    location: normalizeAddress(event.scanLocation),
  };
}

export function normalizeFedExTracking(response) {
  const result = firstTrackResult(response);
  if (!result) {
    return null;
  }

  const latestEvent = normalizeEvent(result.scanEvents?.[0]);
  const estimatedDelivery = result.estimatedDeliveryTimeWindow?.window?.ends ||
    result.estimatedDeliveryTimeWindow?.window?.begins ||
    result.dateAndTimes?.find((item) => item.type === "ESTIMATED_DELIVERY")?.dateTime ||
    null;

  return {
    carrier: "FedEx",
    trackingNumber: compact(result.trackingNumberInfo?.trackingNumber),
    status: compact(result.latestStatusDetail?.description) ||
      compact(result.latestStatusDetail?.derivedCode) ||
      compact(result.derivedStatus),
    statusCode: compact(result.latestStatusDetail?.code),
    estimatedDelivery: compact(estimatedDelivery),
    latestEvent,
  };
}
