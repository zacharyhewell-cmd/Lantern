export const DEFAULT_SOURCE_MIN_COVERAGE = 0.8;

const REQUIRED_SKUS = {
  catalog: ["AACC0019B", "AACC0073A", "AACC0186A-D"],
  costs: ["AACC0019B", "AACC0073A"],
};
const REQUIRED_CARTONS = Array.from({ length: 7 }, (_, index) => `ABOX000${index + 1}`);

export class Dv1SourceValidationError extends Error {
  constructor(rules, summary) {
    super("DV1 source refresh rejected");
    this.name = "Dv1SourceValidationError";
    this.rules = rules;
    this.summary = summary;
  }
}

export function isSourceSku(sku) {
  return typeof sku === "string" && sku.length <= 64 && /^AA[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(sku);
}

function validDimensions(dimensions) {
  return dimensions && ["mm", "in"].includes(dimensions.unit) &&
    [dimensions.length, dimensions.width, dimensions.height].every((value) => Number.isFinite(value) && value > 0);
}

function dimensionsEqual(a, b) {
  return a?.unit === b?.unit && a?.length === b?.length && a?.width === b?.width && a?.height === b?.height;
}

function compareSkus(previous, candidate) {
  const before = new Map(previous.map((record) => [record.sku, record]));
  const after = new Map(candidate.map((record) => [record.sku, record]));
  const added = [...after.keys()].filter((sku) => !before.has(sku)).sort();
  const removed = [...before.keys()].filter((sku) => !after.has(sku)).sort();
  return {
    previousCount: before.size,
    candidateCount: after.size,
    retainedCount: before.size - removed.length,
    added,
    removed,
    changedDimensions: [...after.keys()].filter((sku) =>
      before.has(sku) && !dimensionsEqual(before.get(sku).dimensions, after.get(sku).dimensions)
    ).sort(),
  };
}

export function validateSourceSnapshot(previous, candidate, { minCoverage, baselineKind }) {
  const { referenceCatalog, soloShippingCosts, generatedAt } = candidate;
  const { skus, cartons, generatedFrom: catalogSource } = referenceCatalog;
  const { costs, generatedFrom: costSource } = soloShippingCosts;
  const summary = {
    generatedAt,
    baselineKind,
    catalog: compareSkus(previous.referenceCatalog.skus, skus),
    costs: compareSkus(previous.soloShippingCosts.costs, costs),
    skippedRows: catalogSource.skippedSourceRows,
    blankDimensionRows: catalogSource.blankDimensionRows,
    malformedCatalogRows: catalogSource.malformedSkuRows + catalogSource.invalidDimensionRows,
    malformedCostRows: costSource.malformedSkuRows,
    skippedCostRows: costSource.excludedMissingTrackingOrChargeRows,
    malformedSkus: catalogSource.invalidDimensionSkus,
    conflictingSkus: catalogSource.conflictingSkus,
  };
  const rules = [];
  if (catalogSource.malformedSkuRows || costSource.malformedSkuRows) rules.push("Source rows contain missing or malformed SKUs.");
  if (catalogSource.invalidDimensionRows || skus.some((record) => !validDimensions(record.dimensions))) {
    rules.push("Catalog contains invalid dimensions or unsupported units.");
  }
  if (catalogSource.conflictingSkus.length) rules.push("Catalog contains conflicting duplicate SKU definitions.");
  if (skus.some((record) => !isSourceSku(record.sku)) || costs.some((record) => !isSourceSku(record.sku))) {
    rules.push("A normalized record has an invalid SKU.");
  }
  if (soloShippingCosts.currency !== "USD" || costs.some((record) =>
    !Number.isSafeInteger(record.shipmentCount) || record.shipmentCount <= 0 ||
    !Number.isFinite(record.medianCostUsd) || record.medianCostUsd <= 0 ||
    !Number.isFinite(record.averageCostUsd) || record.averageCostUsd <= 0
  )) {
    rules.push("A solo cost record has invalid counts or USD amounts.");
  }

  const cartonSkus = new Set(cartons.map((carton) => carton.sku));
  if (cartons.length !== REQUIRED_CARTONS.length ||
      REQUIRED_CARTONS.some((sku) => !cartonSkus.has(sku)) ||
      cartons.some((carton) => !validDimensions(carton.innerDimensions))) {
    rules.push("The seven checked-in carton definitions must all be present and have valid dimensions.");
  }

  for (const [name, records] of [["catalog", skus], ["costs", costs]]) {
    const counts = summary[name];
    if (!counts.candidateCount || counts.retainedCount < Math.ceil(counts.previousCount * minCoverage)) {
      rules.push(`The ${name} retained ${counts.retainedCount} of ${counts.previousCount} prior SKUs. Minimum coverage is ${minCoverage * 100}%.`);
    }
    const present = new Set(records.map((record) => record.sku));
    const missing = REQUIRED_SKUS[name].filter((sku) => !present.has(sku));
    if (missing.length) rules.push(`The ${name} is missing representative SKUs ${missing.join(", ")}.`);
  }

  if (rules.length) throw new Dv1SourceValidationError(rules, summary);
  return summary;
}

export function formatSourceRejection({ rules, summary }) {
  const affected = (skus) => {
    const safe = skus.filter(isSourceSku);
    return safe.length ? `${safe.slice(0, 8).join(", ")}${safe.length > 8 ? ` (+${safe.length - 8} more)` : ""}` : "none";
  };
  return [
    "DV1 source refresh rejected",
    summary.generatedAt,
    ...rules.map((rule) => `• ${rule}`),
    `Catalog records: ${summary.catalog.previousCount} previous, ${summary.catalog.candidateCount} candidate. Removed: ${affected(summary.catalog.removed)}.`,
    `Cost records: ${summary.costs.previousCount} previous, ${summary.costs.candidateCount} candidate. Removed: ${affected(summary.costs.removed)}.`,
    `Malformed rows: ${summary.malformedCatalogRows} catalog, ${summary.malformedCostRows} cost. Invalid dimensions: ${affected(summary.malformedSkus)}. Conflicts: ${affected(summary.conflictingSkus)}.`,
    summary.baselineKind === "checked-in"
      ? "DV1 retained the checked-in baseline."
      : "DV1 retained the previous snapshot.",
  ].join("\n");
}
