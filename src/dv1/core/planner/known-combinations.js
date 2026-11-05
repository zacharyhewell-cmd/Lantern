import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
class InMemoryKnownCombinationStore {
  records = /* @__PURE__ */ new Map();
  constructor(records = []) {
    records.forEach((record) => this.put(record));
  }
  get(key) {
    const records = this.getAll(key);
    const record = [...records].sort((a, b) => provenanceRank(a) - provenanceRank(b))[0];
    if (!record) {
      return void 0;
    }
    const updated = { ...record, lastUsedAt: (/* @__PURE__ */ new Date()).toISOString(), useCount: record.useCount + 1 };
    this.replace(updated);
    return updated;
  }
  getAll(key) {
    return [...this.records.get(key) ?? []];
  }
  put(record) {
    const records = this.records.get(record.key) ?? [];
    const index = records.findIndex((existing) => sameSolution(existing, record));
    if (index === -1) {
      records.push(record);
      this.records.set(record.key, records);
    }
  }
  all() {
    return [...this.records.values()].flat();
  }
  replace(record) {
    const records = this.records.get(record.key) ?? [];
    const index = records.findIndex((existing) => sameSolution(existing, record));
    if (index >= 0) {
      records[index] = record;
      this.records.set(record.key, records);
    }
  }
}
class JsonFileKnownCombinationStore {
  constructor(path) {
    this.path = path;
    this.memory = new InMemoryKnownCombinationStore(readRecords(path));
  }
  path;
  memory;
  get(key) {
    const record = this.memory.get(key);
    if (record) {
      this.flush();
    }
    return record;
  }
  getAll(key) {
    return this.memory.getAll(key);
  }
  put(record) {
    this.memory.put(record);
    this.flush();
  }
  flush() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ records: this.memory.all() }, null, 2)}
`);
  }
}
function knownCombinationKey(lines) {
  return lines.map((line) => ({
    sku: line.sku,
    quantity: line.quantity,
    dimensions: line.dimensions,
    packGroup: line.packGroup,
    canPackWith: line.canPackWith ?? null
  })).sort((a, b) => a.sku.localeCompare(b.sku)).map((line) => JSON.stringify(line)).join("|");
}
function createKnownCombinationRecord(key, lines, cartonSku, cartonDimensions, metadata = {}) {
  return {
    key,
    cartonSku,
    cartonDimensions,
    itemSummary: lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      dimensions: line.dimensions
    })).filter((line) => Boolean(line.dimensions)),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    useCount: 0,
    ...metadata
  };
}
function knownCombinationProvenance(record) {
  return record.provenance ?? "geometry_validated";
}
function sameDimensions(a, b) {
  return a.length === b.length && a.width === b.width && a.height === b.height && a.unit === b.unit;
}
function readRecords(path) {
  if (!existsSync(path)) {
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return raw.records ?? [];
}
function provenanceRank(record) {
  return knownCombinationProvenance(record) === "geometry_validated" ? 0 : 1;
}
function sameSolution(a, b) {
  return a.cartonSku === b.cartonSku && (a.warehouseId ?? null) === (b.warehouseId ?? null) && knownCombinationProvenance(a) === knownCombinationProvenance(b);
}
export {
  InMemoryKnownCombinationStore,
  JsonFileKnownCombinationStore,
  createKnownCombinationRecord,
  knownCombinationKey,
  knownCombinationProvenance,
  sameDimensions
};
