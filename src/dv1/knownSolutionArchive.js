import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  archiveableKnownCombination,
  BufferedKnownCombinationStore,
  JsonFileKnownCombinationStore,
  knownCombinationRecordId,
} from "./core/planner/known-combinations.js";

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), "data");

function recordId(record) {
  return knownCombinationRecordId(record);
}

function toRow(record) {
  return [
    recordId(record),
    record.key,
    JSON.stringify(record.itemSummary),
    record.cartonSku,
    JSON.stringify(record.cartonDimensions),
    record.warehouseId || "",
    record.provenance || "geometry_validated",
    record.sourceOrderNumber || "",
    record.sourceNote || "",
    record.createdAt,
    record.lastUsedAt || "",
    record.useCount,
    1,
  ];
}

function parseRow(row) {
  if (!row?.[0]) return null;
  try {
    return {
      key: String(row[1] || ""),
      itemSummary: JSON.parse(String(row[2] || "[]")),
      cartonSku: String(row[3] || ""),
      cartonDimensions: JSON.parse(String(row[4] || "{}")),
      warehouseId: String(row[5] || "") || undefined,
      provenance: String(row[6] || "geometry_validated"),
      sourceOrderNumber: String(row[7] || "") || undefined,
      sourceNote: String(row[8] || "") || undefined,
      createdAt: String(row[9] || new Date().toISOString()),
      lastUsedAt: String(row[10] || "") || undefined,
      useCount: Number(row[11] || 0),
    };
  } catch {
    return null;
  }
}

export class FeishuKnownCombinationSink {
  constructor(feishuClient, spreadsheetToken, sheetId) {
    this.feishuClient = feishuClient;
    this.spreadsheetToken = spreadsheetToken;
    this.sheetId = sheetId;
  }

  async readAll() {
    const response = await this.feishuClient.readSheetRange(
      this.spreadsheetToken,
      `${this.sheetId}!A1:M100000`,
    );
    const values = response?.data?.valueRange?.values || response?.valueRange?.values || [];
    return values.slice(1).map(parseRow).filter(Boolean);
  }

  async append(records) {
    if (!records.length) return;
    const existing = await this.readAll();
    const existingIds = new Set(existing.map(recordId));
    const rows = records.filter((record) => archiveableKnownCombination(record) && !existingIds.has(recordId(record))).map(toRow);
    if (!rows.length) return;
    await this.feishuClient.appendSheetRows(this.spreadsheetToken, `${this.sheetId}!A:M`, rows);
  }
}

export function createDv1KnownCombinationStore({ feishuClient, config } = {}) {
  const localPath = process.env.DV1_KNOWN_COMBINATIONS_PATH || join(dataDirectory, "known-combinations.json");
  const historicalPath = join(dataDirectory, "historical-known-combinations.json");
  const sink = config?.spreadsheetToken && config?.sheetId
    ? new FeishuKnownCombinationSink(feishuClient, config.spreadsheetToken, config.sheetId)
    : undefined;
  return new BufferedKnownCombinationStore(
    new JsonFileKnownCombinationStore(localPath, [historicalPath]),
    sink,
  );
}
