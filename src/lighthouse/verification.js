export function normalizeCustomerEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normalizePostalCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function matchesShippingPostalCode(summary, postalCode) {
  const expected = normalizePostalCode(summary?.verification?.shippingPostalCode);
  const supplied = normalizePostalCode(postalCode);
  if (!expected || !supplied) {
    return false;
  }

  if (expected === supplied) {
    return true;
  }

  const isUsZip = (value) => /^\d{5}(?:\d{4})?$/.test(value);
  return isUsZip(expected) && isUsZip(supplied) && expected.slice(0, 5) === supplied.slice(0, 5);
}
