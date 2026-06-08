import { normalizeOrderIdentifier } from "../orderIds.js";
import { ShopifyClient } from "../shopify/client.js";
import { normalizeShopifyTracking } from "../shopify/normalize.js";
import { formatTrackingReply } from "../formatters/trackingReply.js";
import { enrichSummaryWithFedEx } from "../fedex/enrich.js";

export async function buildShopifyTrackingReply({ orderText, shopifyConfig, fedExConfig }) {
  const orderIdentifier = normalizeOrderIdentifier(orderText);
  if (!orderIdentifier) {
    return "Please include an order number like WS-12345 or 12345.";
  }

  const client = new ShopifyClient(shopifyConfig);
  const orders = await client.findOrdersForTracking(orderIdentifier);
  const summary = normalizeShopifyTracking(orders, orderIdentifier);
  const enrichedSummary = await enrichSummaryWithFedEx(summary, fedExConfig);
  return formatTrackingReply(enrichedSummary);
}
