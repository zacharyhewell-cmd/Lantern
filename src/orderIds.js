export function extractOrderIdentifier(text) {
  if (!text || !/^lantern\b/i.test(text)) {
    return null;
  }

  const match = text.match(/\bWS-#?\d+-F\d+\b|\b\d+-F\d+\b|\bWS-#?\d+\b|\b\d+\b/i);
  return match ? normalizeOrderIdentifier(match[0]) : null;
}

export function normalizeOrderIdentifier(identifier) {
  if (!identifier) {
    return null;
  }

  const value = identifier.trim();
  const fulfillmentMatch = value.match(/^(?:WS-#?)?(\d+)-F(\d+)$/i);
  if (fulfillmentMatch) {
    return {
      raw: value,
      number: fulfillmentMatch[1],
      canonical: `WS-#${fulfillmentMatch[1]}-F${fulfillmentMatch[2]}`,
      orderCanonical: `WS-#${fulfillmentMatch[1]}`,
      fulfillmentSuffix: `F${fulfillmentMatch[2]}`,
      fulfillmentName: `WS-#${fulfillmentMatch[1]}-F${fulfillmentMatch[2]}`,
      candidates: [`WS-#${fulfillmentMatch[1]}`, `WS-${fulfillmentMatch[1]}`, `#${fulfillmentMatch[1]}`, fulfillmentMatch[1]],
    };
  }

  const wsMatch = value.match(/^WS-#?(\d+)$/i);
  if (wsMatch) {
    return {
      raw: value,
      number: wsMatch[1],
      canonical: `WS-#${wsMatch[1]}`,
      orderCanonical: `WS-#${wsMatch[1]}`,
      candidates: [`WS-#${wsMatch[1]}`, `WS-${wsMatch[1]}`, `#${wsMatch[1]}`, wsMatch[1]],
    };
  }

  const numberMatch = value.match(/^(\d+)$/);
  if (numberMatch) {
    return {
      raw: value,
      number: numberMatch[1],
      canonical: numberMatch[1],
      orderCanonical: `WS-#${numberMatch[1]}`,
      candidates: [`#${numberMatch[1]}`, `WS-#${numberMatch[1]}`, `WS-${numberMatch[1]}`, numberMatch[1]],
    };
  }

  return null;
}

export function buildShopifyOrderSearchQuery(orderIdentifier) {
  if (!orderIdentifier?.candidates?.length) {
    throw new Error("Cannot build Shopify query without order candidates");
  }

  return orderIdentifier.candidates.map((candidate) => `name:'${candidate}'`).join(" OR ");
}
