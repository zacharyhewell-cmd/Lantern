import { getFedExConfig, getShopifyConfig, getSurpathConfig } from "../config.js";
import { extractOrderIdentifier } from "../orderIds.js";
import { buildSurpathTrackingReply } from "../tracking/surpathTracking.js";

export function isLanternTrigger(content) {
  return /^lantern\b/i.test(String(content || "").trim());
}

export async function buildLanternReply(content, {
  shopifyConfig = getShopifyConfig(),
  surpathConfig = getSurpathConfig(),
  fedExConfig = getFedExConfig(),
} = {}) {
  if (!isLanternTrigger(content)) {
    return null;
  }

  const orderIdentifier = extractOrderIdentifier(content);
  if (!orderIdentifier) {
    return "Please include an order number like WS-12345 or 12345.";
  }

  try {
    return await buildSurpathTrackingReply({
      orderText: orderIdentifier.raw,
      shopifyConfig,
      surpathConfig,
      fedExConfig,
    });
  } catch (error) {
    if (/rate limit exceeded/i.test(error.message)) {
      return "Lantern could not reach Surpath right now because its lookup service is rate limited. Please try again in a few minutes.";
    }

    console.error(error);
    return "Lantern hit an error while looking up that order. Please try again in a moment.";
  }
}
