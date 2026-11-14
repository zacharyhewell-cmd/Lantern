import { normalizeOrderIdentifier } from "../orderIds.js";
import { ShopifyClient } from "../shopify/client.js";
import { normalizeShopifyTracking } from "../shopify/normalize.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { exactRowsForTracking, normalizeSurpathRows } from "../surpath/normalize.js";
import { enrichSummaryWithFedEx } from "../fedex/enrich.js";
import { matchesShippingPostalCode, normalizeCustomerEmail } from "../lighthouse/verification.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function trackingNumbersFromSummary(summary) {
  return unique(
    (summary.shipments || [])
      .flatMap((shipment) => shipment.tracking || [])
      .map((tracking) => tracking.trackingNumber),
  );
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [row.id, row.sku, row.expressNumber, row.bolCode, row.wmsOutboundCode].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function withTrackingVerification(summary, { shopifySummary, surpathRows = [] } = {}) {
  const shippingPostalCode = shopifySummary?.shippingAddress?.zip ||
    surpathRows.find((row) => row.zip)?.zip ||
    null;

  return {
    ...summary,
    verification: {
      shippingPostalCode,
    },
  };
}

const SURPATH_LOOKUP_PAGE_SIZE = 100;
const SURPATH_LOOKUP_MAX_PAGES = 10;

async function queryAllOutboundOrders(surpathClient, params, {
  pageSize = SURPATH_LOOKUP_PAGE_SIZE,
  maxPages = SURPATH_LOOKUP_MAX_PAGES,
} = {}) {
  const rows = [];
  let totalSize = null;

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    const response = await surpathClient.queryOutboundOrders({
      ...params,
      currentPage,
      pageSize,
    });
    const pageRows = response?.data || [];
    rows.push(...pageRows);
    totalSize = Number(response?.totalSize ?? response?.total ?? totalSize);

    if (!pageRows.length || pageRows.length < pageSize || (totalSize && rows.length >= totalSize)) {
      break;
    }
  }

  return { data: rows, totalSize };
}

export function exactRowsForOrderIdentifier(response, orderIdentifier) {
  const candidates = new Set(
    orderIdentifier.candidates
      .map((candidate) => candidate.toUpperCase()),
  );

  return (response?.data || []).filter((row) => [
    row.platformCode,
    row.referenceCode,
    row.customerPlatformCode,
    row.wmsOutboundCode,
  ].some((value) => candidates.has(String(value || "").toUpperCase())));
}

function shipmentSkus(shipment) {
  return unique((shipment.items || []).map((item) => item.sku));
}

function rowMatchesShippingAddress(row, shippingAddress) {
  if (!shippingAddress) {
    return true;
  }

  const zipMatches = !shippingAddress.zip || row.zip === shippingAddress.zip;
  const companyMatches = shippingAddress.company &&
    normalizeMatchText(row.company) === normalizeMatchText(shippingAddress.company);
  const streetMatches = shippingAddress.address1 &&
    normalizeMatchText(row.street1) === normalizeMatchText(shippingAddress.address1);

  return zipMatches && (companyMatches || streetMatches);
}

function noTrackingGroupKey(row) {
  return [
    row.id,
    row.wmsOutboundCode,
    row.expressNumber,
    row.bolCode,
    row.platformCode,
  ].filter(Boolean).join("|") || String(row.id);
}

function quantityBySku(items) {
  const quantities = new Map();
  for (const item of items || []) {
    if (!item.sku) {
      continue;
    }
    quantities.set(item.sku, (quantities.get(item.sku) || 0) + Number(item.quantity || 0));
  }
  return quantities;
}

function shopifyItemNamesBySku(shopifySummary) {
  const names = new Map();
  const items = [
    ...(shopifySummary.unfulfilledItems || []),
    ...(shopifySummary.shipments || []).flatMap((shipment) => shipment.items || []),
  ];

  for (const item of items) {
    if (item.sku && item.name && !names.has(item.sku)) {
      names.set(item.sku, item.name);
    }
  }

  return names;
}

export function enrichSurpathRowsWithShopifyItemNames(rows, shopifySummary) {
  const namesBySku = shopifyItemNamesBySku(shopifySummary);
  if (!namesBySku.size) {
    return rows;
  }

  return rows.map((row) => ({
    ...row,
    name: namesBySku.get(row.sku) || row.name,
  }));
}

function groupFitsSkuQuantities(rows, expectedQuantities) {
  if (!rows.length || !expectedQuantities.size) {
    return false;
  }

  const groupQuantities = quantityBySku(rows);
  if (!groupQuantities.size) {
    return false;
  }

  for (const [sku, quantity] of groupQuantities) {
    const expectedQuantity = expectedQuantities.get(sku);
    if (!expectedQuantity || quantity > expectedQuantity) {
      return false;
    }
  }

  return true;
}

function rowsMatchingExpectedSkus(rows, expectedQuantities) {
  return rows.filter((row) => expectedQuantities.has(row.sku));
}

function groupCoversExactSkuQuantities(rows, expectedQuantities) {
  const matchingRows = rowsMatchingExpectedSkus(rows, expectedQuantities);
  if (!matchingRows.length || !expectedQuantities.size) {
    return false;
  }

  const matchingQuantities = quantityBySku(matchingRows);
  for (const [sku, expectedQuantity] of expectedQuantities) {
    if (matchingQuantities.get(sku) !== expectedQuantity) {
      return false;
    }
  }

  return true;
}

function rowsGroupedByNoTrackingMatch(response, targetSkus, shippingAddress) {
  const rowsByGroup = new Map();
  for (const row of response?.data || []) {
    if (!rowMatchesShippingAddress(row, shippingAddress)) {
      continue;
    }

    const key = noTrackingGroupKey(row);
    rowsByGroup.set(key, [...(rowsByGroup.get(key) || []), row]);
  }

  return [...rowsByGroup.values()].filter((rows) => (
    rows.some((row) => targetSkus.has(row.sku))
  ));
}

export function exactRowsForNoTrackingShipment(response, shipment, shippingAddress) {
  const skus = new Set(shipmentSkus(shipment));
  const expectedQuantities = quantityBySku(shipment.items);

  return rowsGroupedByNoTrackingMatch(response, skus, shippingAddress).flatMap((rows) => {
    const groupSkus = new Set(rows.map((row) => row.sku));
    return [...skus].every((sku) => groupSkus.has(sku)) && groupCoversExactSkuQuantities(rows, expectedQuantities)
      ? rowsMatchingExpectedSkus(rows, expectedQuantities)
      : [];
  });
}

export function exactRowsForUnfulfilledItems(response, unfulfilledItems, shippingAddress) {
  const skus = new Set(unique((unfulfilledItems || []).map((item) => item.sku)));
  if (!skus.size) {
    return [];
  }

  const expectedQuantities = quantityBySku(unfulfilledItems);

  return rowsGroupedByNoTrackingMatch(response, skus, shippingAddress).flatMap((rows) => {
    const matchingSkus = new Set(rows.map((row) => row.sku).filter((sku) => skus.has(sku)));
    return matchingSkus.size >= 2 && groupFitsSkuQuantities(rows, expectedQuantities) ? rows : [];
  });
}

export async function findDirectSurpathRows(surpathClient, orderIdentifier) {
  const directCandidates = orderIdentifier.candidates
    .filter((candidate) => !/^\d+$/.test(candidate) && !/^#\d+$/.test(candidate));

  if (!directCandidates.length) {
    return [];
  }

  const response = await queryAllOutboundOrders(surpathClient, {
    platformCodeList: directCandidates,
  });

  return exactRowsForOrderIdentifier(response, orderIdentifier);
}

async function findSurpathRowsByTracking(surpathClient, trackingNumbers) {
  if (!trackingNumbers.length) {
    return [];
  }

  const response = await queryAllOutboundOrders(surpathClient, {
    platformCodeList: trackingNumbers,
  }, {
    pageSize: Math.max(SURPATH_LOOKUP_PAGE_SIZE, trackingNumbers.length * 5),
  });

  return trackingNumbers.flatMap((trackingNumber) => exactRowsForTracking(response, trackingNumber));
}

async function findSurpathRowsByNoTrackingShopifyShipments(surpathClient, shopifySummary) {
  const rows = [];
  const shippingAddress = shopifySummary.shippingAddress;
  const noTrackingShipments = (shopifySummary.shipments || []).filter((shipment) => (
    !(shipment.tracking || []).length && shipmentSkus(shipment).length
  ));

  if (!shippingAddress?.zip || !shopifySummary.createdAt || !noTrackingShipments.length) {
    return rows;
  }

  for (const shipment of noTrackingShipments) {
    const anchorDate = shipment.createdAt || shopifySummary.createdAt;
    const createTimeStart = dateOnly(addDays(anchorDate, -10));
    const createTimeEnd = dateOnly(addDays(anchorDate, 10));
    const response = await surpathClient.queryOutboundOrders({
      zip: shippingAddress.zip,
      skuList: shipmentSkus(shipment),
      createTimeStart,
      createTimeEnd,
      currentPage: 1,
      pageSize: 50,
    });
    rows.push(...exactRowsForNoTrackingShipment(response, shipment, shippingAddress));
  }

  return rows;
}

async function findSurpathRowsByUnfulfilledItems(surpathClient, shopifySummary) {
  const shippingAddress = shopifySummary.shippingAddress;
  const skus = unique((shopifySummary.unfulfilledItems || []).map((item) => item.sku));

  if (!shippingAddress?.zip || !shopifySummary.createdAt || !skus.length) {
    return [];
  }

  const response = await surpathClient.queryOutboundOrders({
    zip: shippingAddress.zip,
    skuList: skus,
    createTimeStart: dateOnly(addDays(shopifySummary.createdAt, -1)),
    createTimeEnd: dateOnly(addDays(shopifySummary.createdAt, 20)),
    currentPage: 1,
    pageSize: 100,
  });

  return exactRowsForUnfulfilledItems(response, shopifySummary.unfulfilledItems, shippingAddress);
}

async function loadShopifySummary(shopifyConfig, orderIdentifier) {
  const shopifyClient = new ShopifyClient(shopifyConfig);
  const shopifyOrders = await shopifyClient.findOrdersForTracking(orderIdentifier);
  return normalizeShopifyTracking(shopifyOrders, orderIdentifier);
}

async function tryLoadShopifySummary(shopifyConfig, orderIdentifier, loadShopify = loadShopifySummary) {
  try {
    return await loadShopify(shopifyConfig, orderIdentifier);
  } catch (error) {
    console.error(`Shopify enrichment unavailable: ${error.message}`);
    return {
      found: false,
      requestedOrder: orderIdentifier.raw,
      orderName: orderIdentifier.canonical,
      shipments: [],
      unfulfilledItems: [],
      warnings: ["Shopify enrichment was unavailable; showing Surpath data only."],
    };
  }
}

export function mergeShopifyGaps(surpathSummary, shopifySummary, surpathTrackingNumbers) {
  const missingShopifyShipments = (shopifySummary.shipments || []).filter((shipment) => {
    const shipmentTrackingNumbers = (shipment.tracking || []).map((tracking) => tracking.trackingNumber);
    return shipmentTrackingNumbers.length && shipmentTrackingNumbers.every((trackingNumber) => (
      !surpathTrackingNumbers.has(trackingNumber)
    ));
  });
  const surpathFulfilledBySku = new Map();
  for (const shipment of surpathSummary.shipments || []) {
    for (const item of shipment.items || []) {
      if (!item.sku) {
        continue;
      }

      surpathFulfilledBySku.set(item.sku, (surpathFulfilledBySku.get(item.sku) || 0) + item.quantity);
    }
  }
  const unfulfilledItems = (shopifySummary.unfulfilledItems || [])
    .map((item) => ({
      ...item,
      quantity: Math.max(item.quantity - (surpathFulfilledBySku.get(item.sku) || 0), 0),
    }))
    .filter((item) => item.quantity > 0);

  return {
    ...surpathSummary,
    shipments: [
      ...surpathSummary.shipments,
      ...missingShopifyShipments,
    ],
    unfulfilledItems,
    warnings: [
      ...(surpathSummary.warnings || []),
      ...(missingShopifyShipments.length ? ["Some tracked shipments were not found in Surpath yet; Shopify filled those gaps."] : []),
    ],
  };
}

// Customer lookups must authorize the exact Shopify order before consulting
// any other source. Lantern's internal fallback and heuristic joins stay separate.
export async function lookupOwnedOrderTracking({
  orderText, ownerEmail, postalCode, shopifyConfig, surpathConfig, fedExConfig,
}, {
  loadOrders = (config, identifier) => new ShopifyClient(config).findOrdersForLighthouse(identifier),
  createSurpathClient = (config) => new SurpathMcpClient(config),
  enrichWithFedEx = enrichSummaryWithFedEx,
} = {}) {
  const identifier = normalizeOrderIdentifier(orderText);
  const email = normalizeCustomerEmail(ownerEmail);
  if (!identifier || !email) return null;

  const candidates = new Set(identifier.candidates.map((candidate) => candidate.toUpperCase()));
  const orders = (await loadOrders(shopifyConfig, identifier))
    .filter((order) => candidates.has(String(order.name).toUpperCase()));
  if (orders.length !== 1 || normalizeCustomerEmail(orders[0].email) !== email) return null;

  const shopifySummary = normalizeShopifyTracking(orders, identifier);
  const verifiedSummary = withTrackingVerification(shopifySummary, { shopifySummary });
  if (!matchesShippingPostalCode(verifiedSummary, postalCode)) return null;

  // Keep Shopify's items and shipment membership. Surpath can supplement
  // a shipment only when Shopify supplied its exact tracking number.
  let summary = verifiedSummary;
  const trackingNumbers = trackingNumbersFromSummary(shopifySummary);
  if (trackingNumbers.length) {
    const surpath = createSurpathClient(surpathConfig);
    if (surpath.isConfigured()) {
      try {
        const street = normalizeMatchText(shopifySummary.shippingAddress?.address1);
        const rows = dedupeRows(await findSurpathRowsByTracking(surpath, trackingNumbers))
          .filter((row) => {
            return street && normalizeMatchText(row.street1) === street &&
              matchesShippingPostalCode(verifiedSummary, row.zip);
          });
        const trackingByNumber = new Map(normalizeSurpathRows(rows).shipments.flatMap(
          (shipment) => shipment.tracking.map((tracking) => [tracking.trackingNumber, { tracking, shipment }]),
        ));
        summary = {
          ...summary,
          shipments: summary.shipments.map((shipment) => {
            const match = trackingByNumber.get(shipment.tracking[0]?.trackingNumber);
            if (!match) return shipment;
            return {
              ...shipment,
              status: match.shipment.status,
              tracking: shipment.tracking.map((tracking) => {
                const extra = trackingByNumber.get(tracking.trackingNumber)?.tracking;
                return extra ? { ...tracking, ...extra, trackingUrl: extra.trackingUrl || tracking.trackingUrl } : tracking;
              }),
            };
          }),
        };
      } catch {
        console.error("Lighthouse Surpath enrichment unavailable");
      } finally {
        await surpath.close().catch(() => console.error("Lighthouse Surpath connection cleanup failed"));
      }
    }
  }
  return enrichWithFedEx(summary, fedExConfig);
}

export async function lookupOrderTracking({
  orderText,
  shopifyConfig,
  surpathConfig,
  fedExConfig,
}, {
  createSurpathClient = (config) => new SurpathMcpClient(config),
  loadShopify = loadShopifySummary,
  enrichWithFedEx = enrichSummaryWithFedEx,
} = {}) {
  const orderIdentifier = normalizeOrderIdentifier(orderText);
  if (!orderIdentifier) {
    return null;
  }

  let shopifySummary;

  const surpathClient = createSurpathClient(surpathConfig);
  if (!surpathClient.isConfigured()) {
    shopifySummary = await loadShopify(shopifyConfig, orderIdentifier);
    const enrichedSummary = await enrichWithFedEx(shopifySummary, fedExConfig);
    return withTrackingVerification(enrichedSummary, { shopifySummary });
  }

  try {
    let surpathRows = [];
    if (orderIdentifier.fulfillmentName) {
      shopifySummary = await loadShopify(shopifyConfig, orderIdentifier);
      surpathRows = [
        ...await findSurpathRowsByTracking(surpathClient, trackingNumbersFromSummary(shopifySummary)),
        ...await findSurpathRowsByNoTrackingShopifyShipments(surpathClient, shopifySummary),
      ];
    } else {
      surpathRows = await findDirectSurpathRows(surpathClient, orderIdentifier);
      if (!surpathRows.length) {
        shopifySummary = await loadShopify(shopifyConfig, orderIdentifier);
        surpathRows = [
          ...await findSurpathRowsByTracking(surpathClient, trackingNumbersFromSummary(shopifySummary)),
          ...await findSurpathRowsByNoTrackingShopifyShipments(surpathClient, shopifySummary),
          ...await findSurpathRowsByUnfulfilledItems(surpathClient, shopifySummary),
        ];
      } else {
        shopifySummary = await tryLoadShopifySummary(shopifyConfig, orderIdentifier, loadShopify);
      }
    }
    surpathRows = enrichSurpathRowsWithShopifyItemNames(dedupeRows(surpathRows), shopifySummary);

    if (!surpathRows.length) {
      const enrichedSummary = await enrichWithFedEx(shopifySummary, fedExConfig);
      return withTrackingVerification(enrichedSummary, { shopifySummary });
    }

    const surpathTrackingNumbers = new Set(surpathRows.map((row) => row.expressNumber || row.bolCode).filter(Boolean));
    const surpathSummary = normalizeSurpathRows(surpathRows, {
      orderName: shopifySummary.orderName || orderIdentifier.canonical,
      requestedOrder: orderIdentifier.raw,
      warnings: shopifySummary.found ? [] : [`No Shopify order matched ${orderIdentifier.raw}; showing Surpath data only.`],
    });
    const mergedSummary = mergeShopifyGaps(surpathSummary, shopifySummary, surpathTrackingNumbers);
    const enrichedSummary = await enrichWithFedEx(mergedSummary, fedExConfig);
    return withTrackingVerification(enrichedSummary, { shopifySummary, surpathRows });
  } finally {
    await surpathClient.close();
  }
}
