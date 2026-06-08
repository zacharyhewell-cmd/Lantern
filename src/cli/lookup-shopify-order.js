import { getFedExConfig, getShopifyConfig } from "../config.js";
import { normalizeOrderIdentifier } from "../orderIds.js";
import { ShopifyClient } from "../shopify/client.js";
import { normalizeShopifyTracking } from "../shopify/normalize.js";
import { formatTrackingReply } from "../formatters/trackingReply.js";

const input = process.argv.slice(2).join(" ").trim();
const orderIdentifier = normalizeOrderIdentifier(input);

if (!orderIdentifier) {
  console.error("Usage: npm run lookup -- WS-#12345");
  process.exit(2);
}

try {
  const client = new ShopifyClient(getShopifyConfig());
  const orders = await client.findOrdersForTracking(orderIdentifier);
  const summary = normalizeShopifyTracking(orders, orderIdentifier);
  const { enrichSummaryWithFedEx } = await import("../fedex/enrich.js");
  const enrichedSummary = await enrichSummaryWithFedEx(summary, getFedExConfig());
  console.log(formatTrackingReply(enrichedSummary));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
