function includesAny(value, needles) {
  const normalized = String(value || "").toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

function isInternalCarrierCode(company) {
  return /^[0-9_ -]+$/.test(String(company || "").trim());
}

function normalizeKnownCarrierName(company) {
  if (!company) {
    return null;
  }

  if (includesAny(company, ["fedex", "federal express"]) || /(^|[_ -])fed($|[_ -])/i.test(company)) {
    return "FedEx";
  }

  if (includesAny(company, ["4px", "递四方"])) {
    return "4PX";
  }

  if (includesAny(company, ["tforce", "t-force"])) {
    return "TForce Freight";
  }

  if (includesAny(company, ["ups", "united parcel"])) {
    return "UPS";
  }

  if (includesAny(company, ["usps", "postal service"])) {
    return "USPS";
  }

  if (includesAny(company, ["dhl"])) {
    return "DHL";
  }

  if (includesAny(company, ["ltl"])) {
    return "LTL";
  }

  return null;
}

function carrierFromUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes("fedex.")) return "FedEx";
    if (hostname.includes("4px.")) return "4PX";
    if (hostname.includes("ups.")) return "UPS";
    if (hostname.includes("usps.")) return "USPS";
    if (hostname.includes("dhl.")) return "DHL";
  } catch {
    const fallback = String(url).toLowerCase();
    if (fallback.includes("fedex")) return "FedEx";
    if (fallback.includes("4px")) return "4PX";
    if (fallback.includes("ups")) return "UPS";
    if (fallback.includes("usps")) return "USPS";
    if (fallback.includes("dhl")) return "DHL";
  }

  return null;
}

function carrierFromTrackingNumber(number) {
  const value = String(number || "").replace(/\s+/g, "").toUpperCase();
  if (!value) {
    return null;
  }

  if (/^4PX[0-9A-Z]+$/.test(value)) {
    return "4PX";
  }

  // FedEx commonly uses 12, 15, 20, and 22 digit numeric tracking numbers.
  if (/^\d{12}$/.test(value) || /^\d{15}$/.test(value) || /^\d{20}$/.test(value) || /^\d{22}$/.test(value)) {
    return "FedEx";
  }

  if (/^1Z[0-9A-Z]{16}$/.test(value)) {
    return "UPS";
  }

  if (/^(94|92|93|95)\d{20,22}$/.test(value)) {
    return "USPS";
  }

  return null;
}

export function detectCarrier({ company, trackingNumber, trackingUrl }) {
  const knownCompany = normalizeKnownCarrierName(company);
  if (knownCompany) {
    return knownCompany;
  }

  const urlCarrier = carrierFromUrl(trackingUrl);
  if (urlCarrier) {
    return urlCarrier;
  }

  const companyIsVague = !company || isInternalCarrierCode(company) || includesAny(company, ["other", "unknown"]);
  if (companyIsVague) {
    const numberCarrier = carrierFromTrackingNumber(trackingNumber);
    if (numberCarrier) {
      return numberCarrier;
    }
  }

  return company || "Unknown carrier";
}
