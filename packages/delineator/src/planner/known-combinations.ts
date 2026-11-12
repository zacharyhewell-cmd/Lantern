import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Dimensions, OrderLine } from "../domain/types.js";

export const GEOMETRY_PROOF_VERSION = 2;

export type KnownCombinationProvenance =
  | "geometry_validated"
  | "human_confirmed"
  | "historical_import";

export interface KnownCombinationRecord {
  key: string;
  cartonSku: string;
  cartonDimensions: Dimensions;
  itemSummary: Array<{
    sku: string;
    quantity: number;
    dimensions: Dimensions;
  }>;
  createdAt: string;
  lastUsedAt?: string;
  useCount: number;
  /** Legacy geometry claims require a new proof before they can bypass packing. */
  geometryProofVersion?: number;
  provenance?: KnownCombinationProvenance;
  /** Optional warehouse scope for solutions that depend on local operations. */
  warehouseId?: string;
  /** The DV1 order that caused this record to be created, when available. */
  sourceOrderNumber?: string;
  sourceNote?: string;
}

export interface KnownCombinationStore {
  get(key: string): KnownCombinationRecord | undefined;
  getAll(key: string): KnownCombinationRecord[];
  put(record: KnownCombinationRecord): void;
}

export class InMemoryKnownCombinationStore implements KnownCombinationStore {
  private readonly records = new Map<string, KnownCombinationRecord[]>();

  constructor(records: KnownCombinationRecord[] = []) {
    records.forEach((record) => this.put(record));
  }

  get(key: string): KnownCombinationRecord | undefined {
    const records = this.getAll(key);
    const record = [...records].sort((a, b) => provenanceRank(a) - provenanceRank(b))[0];

    if (!record) {
      return undefined;
    }

    const updated = { ...record, lastUsedAt: new Date().toISOString(), useCount: record.useCount + 1 };
    this.replace(updated);

    return updated;
  }

  getAll(key: string): KnownCombinationRecord[] {
    return [...(this.records.get(key) ?? [])];
  }

  put(record: KnownCombinationRecord): void {
    const records = this.records.get(record.key) ?? [];
    const index = records.findIndex((existing) => sameSolution(existing, record));
    if (index === -1) {
      records.push(record);
      this.records.set(record.key, records);
    }
  }

  all(): KnownCombinationRecord[] {
    return [...this.records.values()].flat();
  }

  private replace(record: KnownCombinationRecord): void {
    const records = this.records.get(record.key) ?? [];
    const index = records.findIndex((existing) => sameSolution(existing, record));
    if (index >= 0) {
      records[index] = record;
      this.records.set(record.key, records);
    }
  }
}

export class JsonFileKnownCombinationStore implements KnownCombinationStore {
  private readonly memory: InMemoryKnownCombinationStore;

  constructor(private readonly path: string, seedPaths: string[] = []) {
    this.memory = new InMemoryKnownCombinationStore([
      ...seedPaths.flatMap((seedPath) => readRecords(seedPath)),
      ...readRecords(path)
    ]);
  }

  get(key: string): KnownCombinationRecord | undefined {
    const record = this.memory.get(key);

    if (record) {
      this.flush();
    }

    return record;
  }

  getAll(key: string): KnownCombinationRecord[] {
    return this.memory.getAll(key);
  }

  put(record: KnownCombinationRecord): void {
    this.memory.put(record);
    this.flush();
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ records: this.memory.all() }, null, 2)}\n`);
    renameSync(temporaryPath, this.path);
  }

  all(): KnownCombinationRecord[] {
    return this.memory.all();
  }

  persistedRecords(): KnownCombinationRecord[] {
    return readRecords(this.path);
  }
}

export interface KnownCombinationSink {
  append(records: KnownCombinationRecord[]): Promise<void>;
  readAll(): Promise<KnownCombinationRecord[]>;
}

export interface FlushableKnownCombinationStore extends KnownCombinationStore {
  flushPending(): Promise<{ attempted: number; persisted: number; skipped: boolean }>;
  hydrateFromRemote(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Keeps the planner synchronous and fast while making new records durable in
 * batches. The local JSON file is the write-ahead buffer; the sink is the
 * durable Feishu archive. Failed batches remain pending for a later retry.
 */
export class BufferedKnownCombinationStore implements FlushableKnownCombinationStore {
  private readonly pending = new Map<string, KnownCombinationRecord>();
  private flushInFlight: Promise<{ attempted: number; persisted: number; skipped: boolean }> | null = null;

  constructor(
    private readonly local: JsonFileKnownCombinationStore,
    private readonly sink?: KnownCombinationSink
  ) {}

  get(key: string): KnownCombinationRecord | undefined {
    return this.local.get(key);
  }

  getAll(key: string): KnownCombinationRecord[] {
    return this.local.getAll(key);
  }

  put(record: KnownCombinationRecord): void {
    const alreadyKnown = this.local.getAll(record.key).some((existing) => sameSolution(existing, record));
    this.local.put(record);
    if (!alreadyKnown && archiveableKnownCombination(record)) {
      this.pending.set(knownCombinationRecordId(record), record);
    }
  }

  async hydrateFromRemote(): Promise<number> {
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

  async flushPending(): Promise<{ attempted: number; persisted: number; skipped: boolean }> {
    if (!this.sink) {
      return { attempted: this.pending.size, persisted: 0, skipped: true };
    }
    if (this.flushInFlight) return this.flushInFlight;

    const batch = [...this.pending.values()];
    if (batch.length === 0) return { attempted: 0, persisted: 0, skipped: false };

    this.flushInFlight = this.sink.append(batch)
      .then(() => {
        for (const record of batch) this.pending.delete(knownCombinationRecordId(record));
        return { attempted: batch.length, persisted: batch.length, skipped: false };
      })
      .finally(() => {
        this.flushInFlight = null;
      });

    return this.flushInFlight;
  }

  async close(): Promise<void> {
    await this.flushPending();
  }
}

export function knownCombinationKey(lines: OrderLine[]): string {
  return lines
    .map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      dimensions: line.dimensions,
      packGroup: line.packGroup,
      canPackWith: line.canPackWith ?? null
    }))
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((line) => JSON.stringify(line))
    .join("|");
}

export function createKnownCombinationRecord(
  key: string,
  lines: OrderLine[],
  cartonSku: string,
  cartonDimensions: Dimensions,
  metadata: Pick<KnownCombinationRecord, "provenance" | "geometryProofVersion" | "warehouseId" | "sourceOrderNumber" | "sourceNote"> = {}
): KnownCombinationRecord {
  return {
    key,
    cartonSku,
    cartonDimensions,
    itemSummary: lines
      .map((line) => ({
        sku: line.sku,
        quantity: line.quantity,
        dimensions: line.dimensions
      }))
      .filter((line): line is KnownCombinationRecord["itemSummary"][number] => Boolean(line.dimensions)),
    createdAt: new Date().toISOString(),
    useCount: 0,
    ...metadata
  };
}

export function knownCombinationProvenance(record: KnownCombinationRecord): KnownCombinationProvenance {
  return record.provenance ?? "geometry_validated";
}

export function sameDimensions(a: Dimensions, b: Dimensions): boolean {
  return Boolean(a && b && a.length === b.length && a.width === b.width && a.height === b.height && a.unit === b.unit);
}

export function knownCombinationRecordId(record: KnownCombinationRecord): string {
  const identity = [
    record.key,
    record.cartonSku,
    record.warehouseId ?? "",
    knownCombinationProvenance(record)
  ];
  if (record.geometryProofVersion) {
    const { length, width, height, unit } = record.cartonDimensions;
    identity.push(String(record.geometryProofVersion), JSON.stringify([length, width, height, unit]));
  }
  return createHash("sha256").update(identity.join("::")).digest("hex");
}

export function archiveableKnownCombination(record: KnownCombinationRecord): boolean {
  return knownCombinationProvenance(record) !== "historical_import";
}

function readRecords(path: string): KnownCombinationRecord[] {
  if (!existsSync(path)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as { records?: KnownCombinationRecord[] };
  return raw.records ?? [];
}

function provenanceRank(record: KnownCombinationRecord): number {
  return knownCombinationProvenance(record) === "geometry_validated" ? 0 : 1;
}

export function sameSolution(a: KnownCombinationRecord, b: KnownCombinationRecord): boolean {
  return a.cartonSku === b.cartonSku &&
    (a.warehouseId ?? null) === (b.warehouseId ?? null) &&
    knownCombinationProvenance(a) === knownCombinationProvenance(b) &&
    a.geometryProofVersion === b.geometryProofVersion &&
    sameDimensions(a.cartonDimensions, b.cartonDimensions);
}
