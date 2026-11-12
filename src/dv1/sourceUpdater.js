import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SOURCE_MIN_COVERAGE,
  Dv1SourceValidationError,
  formatSourceRejection,
  isSourceSku,
  validateSourceSnapshot,
} from "./sourceValidation.js";

const DEFAULT_CATALOG = {
  spreadsheetToken: "UsMXsBUuKha13jt0W4jciGgyn6g",
  sheetId: "2b1183",
  sourceTitle: "Accessories Package Dimension",
  columns: "A:H",
};

const DEFAULT_FEDEX = {
  spreadsheetToken: "T7Mbs087hhtWtrtffoec84IBnpf",
  sheetId: "qFDTIF",
  sourceTitle: "派送费明细 （Fedex）2026",
  columns: "A:M",
};

const PAGE_SIZE = 10_000;

export async function refreshDv1SourceSnapshots({
  feishuClient,
  catalog: catalogOptions,
  fedex: fedexOptions,
  catalogBaselinePath,
  costsBaselinePath,
  snapshotPath,
  minCoverage = DEFAULT_SOURCE_MIN_COVERAGE,
  now = () => new Date(),
} = {}) {
  if (!feishuClient?.readSheetRange) {
    throw new Error("Missing Feishu Sheet client for DV1 source refresh");
  }

  if (!Number.isFinite(minCoverage) || minCoverage <= 0 || minCoverage > 1) {
    throw new Error("DV1 source minimum coverage must be greater than 0 and at most 1");
  }

  const catalog = { ...DEFAULT_CATALOG, ...catalogOptions };
  const fedex = { ...DEFAULT_FEDEX, ...fedexOptions };
  const generatedAt = now().toISOString();
  const [catalogRows, fedexRows] = await Promise.all([
    readAllRows(feishuClient, catalog.spreadsheetToken, catalog.sheetId, catalog.columns, catalog.maxRows),
    readAllRows(feishuClient, fedex.spreadsheetToken, fedex.sheetId, fedex.columns, fedex.maxRows),
  ]);

  const referenceCatalog = buildReferenceCatalog(catalogRows, {
    ...catalog,
    fetchedAt: generatedAt,
  });
  const soloShippingCosts = buildSoloShippingCosts(fedexRows, {
    ...fedex,
    generatedAt: generatedAt.slice(0, 10),
  });

  const baseline = await readJson(catalogBaselinePath);
  referenceCatalog.cartons = baseline.cartons ?? [];
  const active = await readJson(snapshotPath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const previous = active ?? {
    referenceCatalog: baseline,
    soloShippingCosts: await readJson(costsBaselinePath),
  };
  const candidate = { generatedAt, referenceCatalog, soloShippingCosts };
  const summary = validateSourceSnapshot(previous, candidate, {
    minCoverage,
    baselineKind: active ? "active" : "checked-in",
  });
  await atomicWriteJson(snapshotPath, candidate);
  return summary;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export function startDv1SourceRefreshScheduler({
  enabled,
  intervalMs,
  refresh,
  sendRejectionAlert,
  logger = console,
  initialDelayMs = 5_000,
} = {}) {
  if (!enabled) return { stop() {} };
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    try {
      const result = await refresh();
      logger.error?.(`[dv1] source refresh complete: ${JSON.stringify(result)}`);
    } catch (error) {
      if (error instanceof Dv1SourceValidationError) {
        const message = formatSourceRejection(error);
        logger.error?.(`[dv1] ${message}`);
        try {
          await sendRejectionAlert?.(message, { idempotencyKey: randomUUID() });
        } catch (alertError) {
          logger.error?.(`[dv1] source refresh rejection alert failed: ${alertError.message}`);
        }
      } else {
        logger.error?.(`[dv1] source refresh failed; previous snapshots remain active: ${error.message}`);
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  const startup = setTimeout(run, initialDelayMs);
  startup.unref?.();
  logger.error?.(`[dv1] source refresh enabled every ${intervalMs}ms`);
  return { run, stop() { clearInterval(timer); clearTimeout(startup); } };
}

export async function readAllRows(client, spreadsheetToken, sheetId, columns, maxRows = 250_000) {
  const rows = [];
  for (let start = 1; start <= maxRows; start += PAGE_SIZE) {
    const end = Math.min(maxRows, start + PAGE_SIZE - 1);
    const response = await client.readSheetRange(spreadsheetToken, `${sheetId}!${columns.split(":")[0]}${start}:${columns.split(":")[1]}${end}`);
    const values = response?.data?.valueRange?.values || response?.valueRange?.values || [];
    if (!values.length) break;
    rows.push(...values);
    if (values.length < PAGE_SIZE) break;
  }
  return rows;
}

export function buildReferenceCatalog(rows, metadata = {}) {
  const definitions = new Map();
  const invalidDimensionSkus = new Set();
  const conflictingSkus = [];
  let previousName;
  let sourceRowCount = 0;
  let skippedRows = 0;
  let blankDimensionRows = 0;
  let malformedSkuRows = 0;
  let invalidDimensionRows = 0;

  rows.slice(1).forEach((rawRow, index) => {
    const row = Array.isArray(rawRow) ? rawRow : [];
    if (!row.slice(0, 7).some((value) => compact(value))) return;
    sourceRowCount += 1;
    let name = compact(row[1]);
    const sku = canonicalizeSku(row[2]);
    const bulk = sku.endsWith("-D");
    const dimensionCell = compact(bulk ? row[5] : row[3]);
    const expandedSkus = sku ? expandSku(sku) : [];
    if (!expandedSkus.length || expandedSkus.some((value) => !isSourceSku(value))) {
      if (sku || compact(row[3]) || compact(row[5])) malformedSkuRows += 1;
      skippedRows += 1;
      return;
    }
    if (!dimensionCell) {
      blankDimensionRows += 1;
      skippedRows += 1;
      return;
    }
    const dimensions = parseDimensions(dimensionCell);
    if (!dimensions) {
      invalidDimensionRows += 1;
      for (const value of expandedSkus) invalidDimensionSkus.add(value);
      skippedRows += 1;
      return;
    }
    if (name) previousName = name;
    else if (bulk) name = previousName;
    const weight = parseWeightKg(bulk ? row[6] : row[4]);
    for (const expandedSku of expandedSkus) {
      const expanded = expandedSku !== sku;
      const record = {
        sku: expandedSku,
        ...(name ? { name } : {}),
        dimensions,
        ...(weight ? { weight } : {}),
        packGroup: "standard",
        sourceNote: `Imported from Feishu Accessories Package Dimension columns A-G. Source row ${index + 2}; source SKU ${sku}; dimensions from column ${bulk ? "F" : "D"}${weight ? `; weight from column ${bulk ? "G" : "E"}.` : "."}${expanded ? ` Expanded from source SKU ${sku}.` : ""}`,
      };
      const existing = definitions.get(expandedSku);
      if (!existing || (existing.expanded && !expanded)) {
        definitions.set(expandedSku, { expanded, records: [record] });
      } else if (existing.expanded === expanded) {
        existing.records.push(record);
      }
    }
  });

  const bySku = new Map();
  for (const [sku, { records }] of definitions) {
    const chosen = records.find((record) => record.weight) ?? records[0];
    if (records.some((record) =>
      JSON.stringify(record.dimensions) !== JSON.stringify(chosen.dimensions) ||
      (record.weight && record.weight.value !== chosen.weight?.value)
    )) {
      conflictingSkus.push(sku);
    }
    bySku.set(sku, chosen);
  }

  // Product-team/catalog update lag: until a source row is supplied, treat
  // AACC0099B as dimensionally equivalent to the established AACC0099A SKU.
  if (!bySku.has("AACC0099B") && bySku.has("AACC0099A")) {
    const alias = { ...bySku.get("AACC0099A"), sku: "AACC0099B" };
    alias.sourceNote = `${alias.sourceNote || "Inherited from the reference catalog."} User-directed alias: AACC0099B is assumed dimensionally equivalent to AACC0099A pending alternate product-team information.`;
    bySku.set("AACC0099B", alias);
  }

  return {
    generatedFrom: {
      sourceType: "feishu-sheet",
      sourceTitle: metadata.sourceTitle || DEFAULT_CATALOG.sourceTitle,
      spreadsheetToken: metadata.spreadsheetToken,
      sheetId: metadata.sheetId,
      fetchedAt: metadata.fetchedAt,
      sourceColumns: ["A", "B", "C", "D", "E", "F", "G"],
      excludedColumns: ["H"],
      sourceRowCount,
      includedSourceRows: sourceRowCount - skippedRows,
      skippedSourceRows: skippedRows,
      blankDimensionRows,
      malformedSkuRows,
      invalidDimensionRows,
      invalidDimensionSkus: [...invalidDimensionSkus].sort(),
      conflictingSkus: conflictingSkus.sort(),
    },
    skus: [...bySku.values()],
    cartons: [],
  };
}

export function buildSoloShippingCosts(rows, metadata = {}) {
  const dataRows = rows.slice(1);
  const byTracking = new Map();
  let aaRows = 0;
  let malformedSkuRows = 0;
  let excludedMissingTrackingOrCharge = 0;

  for (const rawRow of dataRows) {
    const row = [...rawRow, ...Array(13).fill(null)].slice(0, 13);
    const tracking = String(row[5] || "").trim();
    const sku = canonicalizeSku(row[6]);
    const charge = Number(row[12]) || 0;
    if (!sku.startsWith("AA")) continue;
    if (!isSourceSku(sku)) {
      malformedSkuRows += 1;
      continue;
    }
    aaRows += 1;
    if (!tracking || charge <= 0) excludedMissingTrackingOrCharge += 1;
    if (tracking) {
      const values = byTracking.get(tracking) || [];
      values.push({ row, sku, charge });
      byTracking.set(tracking, values);
    }
  }

  const costsBySku = new Map();
  let mixedTrackingCount = 0;
  for (const trackingRows of byTracking.values()) {
    const skus = new Set(trackingRows.map((entry) => entry.sku));
    if (skus.size !== 1 || trackingRows.length !== 1) {
      mixedTrackingCount += 1;
      continue;
    }
    const entry = trackingRows[0];
    if (entry.charge > 0) {
      const values = costsBySku.get(entry.sku) || [];
      values.push(entry.charge);
      costsBySku.set(entry.sku, values);
    }
  }

  const costs = [...costsBySku.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sku, values]) => ({
    sku,
    shipmentCount: values.length,
    averageCostUsd: round(mean(values)),
    medianCostUsd: round(median(values)),
    p75CostUsd: round(percentile(values, 0.75)),
    p90CostUsd: round(percentile(values, 0.9)),
    minCostUsd: round(Math.min(...values)),
    maxCostUsd: round(Math.max(...values)),
    sourceNote: "Tracking-level single-SKU AA baseline from Feishu FedEx 2026 column M charged amount; AA -D variants included.",
  }))

  return {
    currency: "USD",
    generatedFrom: {
      spreadsheetToken: metadata.spreadsheetToken,
      sheetId: metadata.sheetId,
      sourceTitle: metadata.sourceTitle || DEFAULT_FEDEX.sourceTitle,
      sourceColumns: [..."ABCDEFGHIJKLM"],
      scannedRows: dataRows.length,
      aaRows,
      malformedSkuRows,
      singleSkuTrackingObservations: costs.reduce((sum, cost) => sum + cost.shipmentCount, 0),
      mixedSkuTrackingObservations: mixedTrackingCount,
      excludedMissingTrackingOrChargeRows: excludedMissingTrackingOrCharge,
      includesDVariants: true,
      generatedAt: metadata.generatedAt,
      provisional: true,
      method: "Tracking-level paid single-SKU AA observations; mixed-SKU packages retained as separate evidence for future consolidation calibration.",
    },
    costs,
  };
}

function compact(value) {
  return value === null || value === undefined || value === "" ? null : String(value).trim();
}

function canonicalizeSku(value) {
  const sku = String(value || "").trim().toUpperCase().replace(/\s*-\s*/g, "-");
  return sku === "AACCO167A-D" ? "AACC0167A-D" : sku;
}

function expandSku(sku) {
  if (sku.includes("/")) {
    const parts = sku.split("/");
    const first = parts[0].match(/^([A-Z]+)(\d+)([A-Z])$/);
    if (!first) return [sku];
    return [parts[0], ...parts.slice(1).map((part) => {
      const match = part.match(/^(\d+)([A-Z])$/);
      return match ? `${first[1]}${match[1].padStart(first[2].length, "0")}${match[2]}` : part;
    })];
  }
  const range = sku.match(/^([A-Z]+)(\d+)([A-Z])-(\d+)([A-Z])$/);
  if (!range || range[3] !== range[5]) return [sku];
  const [, prefix, startDigits, suffix, endDigits] = range;
  const endPrefix = endDigits.length < startDigits.length ? startDigits.slice(0, -endDigits.length) : "";
  const end = Number(`${endPrefix}${endDigits}`);
  const start = Number(startDigits);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start >= PAGE_SIZE) return [];
  return Array.from({ length: end - start + 1 }, (_, index) => `${prefix}${String(start + index).padStart(startDigits.length, "0")}${suffix}`);
}

function parseDimensions(value) {
  // The saved sheet has one redundant "mmmm" suffix. Both spellings identify millimeters.
  const match = value.match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm|mmmm)?$/iu);
  if (!match) return null;
  const [length, width, height] = match.slice(1).map(Number);
  if (![length, width, height].every((side) => Number.isFinite(side) && side > 0)) return null;
  return { length, width, height, unit: "mm" };
}

function parseWeightKg(value) {
  if (value === null || value === undefined || value === "" || value === "/") return null;
  const kilograms = Number(value);
  const pounds = Math.round(kilograms * 2.20462262185 * 1000) / 1000;
  return Number.isFinite(pounds) && pounds > 0 ? { value: pounds, unit: "lb" } : null;
}

function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function median(values) { return percentile(values, 0.5); }
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}
function round(value) { return Math.round(value * 100) / 100; }

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
