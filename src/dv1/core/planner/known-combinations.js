import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

  replace(record) {
    const records = this.records.get(record.key) ?? [];
    const index = records.findIndex((existing) => sameSolution(existing, record));
    if (index >= 0) {
      records[index] = record;
      this.records.set(record.key, records);
    }
  }
  all() {
    return [...this.records.values()].flat();
  }
}
class JsonFileKnownCombinationStore {
  constructor(path, seedPaths = []) {
    this.path = path;
    this.memory = new InMemoryKnownCombinationStore([
      ...seedPaths.flatMap((seedPath) => readRecords(seedPath)),
      ...readRecords(path)
    ]);
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
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ records: this.memory.all() }, null, 2)}
`);
    renameSync(temporaryPath, this.path);
  }
  all() {
    return this.memory.all();
  }
  persistedRecords() {
    return readRecords(this.path);
  }
}

export class BufferedKnownCombinationStore {
  constructor(local, sink) {
    this.local = local;
    this.sink = sink;
    this.pending = /* @__PURE__ */ new Map();
    this.flushInFlight = null;
  }
  get(key) {
    return this.local.get(key);
  }
  getAll(key) {
    return this.local.getAll(key);
  }
  put(record) {
    const alreadyKnown = this.local.getAll(record.key).some((existing) => sameSolution(existing, record));
    this.local.put(record);
    if (!alreadyKnown && archiveableKnownCombination(record)) {
      this.pending.set(knownCombinationRecordId(record), record);
    }
  }
  async hydrateFromRemote() {
    if (!this.sink) return 0;
    const records = await this.sink.readAll();
    const remoteIds = new Set(records.map(knownCombinationRecordId));
    let added = 0;
    for (const record of records) {
      if (!archiveableKnownCombination(record)) continue;
      const before = this.local.getAll(record.key).length;
      this.local.put(record);
      if (this.local.getAll(record.key).length > before) added += 1;
    }
    for (const record of this.local.persistedRecords()) {
      if (archiveableKnownCombination(record) && !remoteIds.has(knownCombinationRecordId(record))) {
        this.pending.set(knownCombinationRecordId(record), record);
      }
    }
    return added;
  }
  async flushPending() {
    if (!this.sink) return { attempted: this.pending.size, persisted: 0, skipped: true };
    if (this.flushInFlight) return this.flushInFlight;
    const batch = [...this.pending.values()];
    if (batch.length === 0) return { attempted: 0, persisted: 0, skipped: false };
    this.flushInFlight = this.sink.append(batch).then(() => {
      for (const record of batch) this.pending.delete(knownCombinationRecordId(record));
      return { attempted: batch.length, persisted: batch.length, skipped: false };
    }).finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }
  async close() {
    await this.flushPending();
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
function knownCombinationRecordId(record) {
  const identity = [record.key, record.cartonSku, record.warehouseId ?? "", knownCombinationProvenance(record)].join("::");
  return createHash("sha256").update(identity).digest("hex");
}
function archiveableKnownCombination(record) {
  return knownCombinationProvenance(record) !== "historical_import";
}
export {
  archiveableKnownCombination,
  InMemoryKnownCombinationStore,
  JsonFileKnownCombinationStore,
  createKnownCombinationRecord,
  knownCombinationKey,
  knownCombinationRecordId,
  knownCombinationProvenance,
  sameDimensions
};
