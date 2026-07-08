import { getFedExConfig, getShopifyConfig, getSurpathConfig } from "../config.js";
import { extractOrderIdentifier } from "../orderIds.js";
import { buildSurpathTrackingReply } from "../tracking/surpathTracking.js";

export const LANTERN_SPELLING_REPLY = "Lantern. L A N T E R N. Lantern.";

export function isLanternTrigger(content) {
  return /^lantern\b/i.test(String(content || "").trim());
}

function editDistance(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) {
    rows[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost,
      );
    }
  }

  return rows[left.length][right.length];
}

export function isLanternMisspellingTrigger(content) {
  const firstWord = String(content || "").trim().match(/^([A-Za-z]{5,9})\b/)?.[1]?.toLowerCase();
  if (!firstWord || firstWord === "lantern") {
    return false;
  }

  return editDistance(firstWord, "lantern") <= 2;
}

export function isLanternRequestTrigger(content) {
  return isLanternTrigger(content) || isLanternMisspellingTrigger(content);
}

export async function buildLanternReply(content, {
  shopifyConfig = getShopifyConfig(),
  surpathConfig = getSurpathConfig(),
  fedExConfig = getFedExConfig(),
} = {}) {
  if (isLanternMisspellingTrigger(content)) {
    return LANTERN_SPELLING_REPLY;
  }

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
