import { formatTrackingReply } from "../formatters/trackingReply.js";
import { lookupOrderTracking } from "./surpathTracking.js";

export async function buildSurpathTrackingReply(options, dependencies) {
  const summary = await lookupOrderTracking(options, dependencies);
  if (!summary) {
    return "Please include an order number like WS-12345 or 12345.";
  }

  return formatTrackingReply(summary);
}
