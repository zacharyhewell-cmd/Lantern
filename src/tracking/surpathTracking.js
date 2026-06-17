import { normalizeOrderIdentifier } from "../orderIds.js";
import { ShopifyClient } from "../shopify/client.js";
import { normalizeShopifyTracking } from "../shopify/normalize.js";
import { SurpathMcpClient } from "../surpath/client.js";
import { exactRowsForTracking, normalizeSurpathRows } from "../surpath/normalize.js";
import { formatTrackingReply } from "../formatters/trackingReply.js";
import { enrichSummaryWithFedEx } from "../fedex/enrich.js";

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

async function findDirectSurpathRows(surpathClient, orderIdentifier) {
  const directCandidates = orderIdentifier.candidates
    .filter((candidate) => !/^\d+$/.test(candidate) && !/^#\d+$/.test(candidate));

  if (!directCandidates.length) {
    return [];
  }

  const response = await surpathClient.queryOutboundOrders({
    platformCodeList: directCandidates,
    currentPage: 1,
    pageSize: 20,
  });

  return exactRowsForOrderIdentifier(response, orderIdentifier);
}

async function findSurpathRowsByTracking(surpathClient, trackingNumbers) {
  if (!trackingNumbers.length) {
    return [];
  }

  const response = await surpathClient.queryOutboundOrders({
    platformCodeList: trackingNumbers,
    currentPage: 1,
    pageSize: Math.max(20, trackingNumbers.length * 5),
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

async function tryLoadShopifySummary(shopifyConfig, orderIdentifier) {
  try {
    return await loadShopifySummary(shopifyConfig, orderIdentifier);
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

export async function buildSurpathTrackingReply({
  orderText,
  shopifyConfig,
  surpathConfig,
  fedExConfig,
}) {
  const orderIdentifier = normalizeOrderIdentifier(orderText);
  if (!orderIdentifier) {
    return "Please include an order number like WS-12345 or 12345.";
  }

  let shopifySummary;

  const surpathClient = new SurpathMcpClient(surpathConfig);
  if (!surpathClient.isConfigured()) {
    shopifySummary = await loadShopifySummary(shopifyConfig, orderIdentifier);
    const enrichedShopifySummary = await enrichSummaryWithFedEx(shopifySummary, fedExConfig);
    return formatTrackingReply(enrichedShopifySummary);
  }

  try {
    let surpathRows = [];
    if (orderIdentifier.fulfillmentName) {
      shopifySummary = await loadShopifySummary(shopifyConfig, orderIdentifier);
      surpathRows = [
        ...await findSurpathRowsByTracking(surpathClient, trackingNumbersFromSummary(shopifySummary)),
        ...await findSurpathRowsByNoTrackingShopifyShipments(surpathClient, shopifySummary),
      ];
    } else {
      surpathRows = await findDirectSurpathRows(surpathClient, orderIdentifier);
      if (!surpathRows.length) {
        shopifySummary = await loadShopifySummary(shopifyConfig, orderIdentifier);
        surpathRows = [
          ...await findSurpathRowsByTracking(surpathClient, trackingNumbersFromSummary(shopifySummary)),
          ...await findSurpathRowsByNoTrackingShopifyShipments(surpathClient, shopifySummary),
          ...await findSurpathRowsByUnfulfilledItems(surpathClient, shopifySummary),
        ];
      } else {
        shopifySummary = await tryLoadShopifySummary(shopifyConfig, orderIdentifier);
      }
    }
    surpathRows = enrichSurpathRowsWithShopifyItemNames(dedupeRows(surpathRows), shopifySummary);

    if (!surpathRows.length) {
      const enrichedShopifySummary = await enrichSummaryWithFedEx(shopifySummary, fedExConfig);
      return formatTrackingReply(enrichedShopifySummary);
    }

    const surpathTrackingNumbers = new Set(surpathRows.map((row) => row.expressNumber || row.bolCode).filter(Boolean));
    const surpathSummary = normalizeSurpathRows(surpathRows, {
      orderName: shopifySummary.orderName || orderIdentifier.canonical,
      requestedOrder: orderIdentifier.raw,
      warnings: shopifySummary.found ? [] : [`No Shopify order matched ${orderIdentifier.raw}; showing Surpath data only.`],
    });
    const mergedSummary = mergeShopifyGaps(surpathSummary, shopifySummary, surpathTrackingNumbers);
    const enrichedSummary = await enrichSummaryWithFedEx(mergedSummary, fedExConfig);
    return formatTrackingReply(enrichedSummary);
  } finally {
    await surpathClient.close();
  }
}
