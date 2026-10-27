import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export class InMemoryKnownCombinationStore {
    records = new Map();
    constructor(records = []) {
        records.forEach((record) => this.records.set(record.key, record));
    }
    get(key) {
        const record = this.records.get(key);
        if (!record) {
            return undefined;
        }
        const updated = { ...record, lastUsedAt: new Date().toISOString(), useCount: record.useCount + 1 };
        this.records.set(key, updated);
        return updated;
    }
    put(record) {
        if (!this.records.has(record.key)) {
            this.records.set(record.key, record);
        }
    }
    all() {
        return [...this.records.values()];
    }
}
export class JsonFileKnownCombinationStore {
    path;
    memory;
    constructor(path) {
        this.path = path;
        this.memory = new InMemoryKnownCombinationStore(readRecords(path));
    }
    get(key) {
        const record = this.memory.get(key);
        if (record) {
            this.flush();
        }
        return record;
    }
    put(record) {
        this.memory.put(record);
        this.flush();
    }
    flush() {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, `${JSON.stringify({ records: this.memory.all() }, null, 2)}\n`);
    }
}
export function knownCombinationKey(lines) {
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
export function createKnownCombinationRecord(key, lines, cartonSku, cartonDimensions) {
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
            .filter((line) => Boolean(line.dimensions)),
        createdAt: new Date().toISOString(),
        useCount: 0
    };
}
export function sameDimensions(a, b) {
    return a.length === b.length && a.width === b.width && a.height === b.height && a.unit === b.unit;
}
function readRecords(path) {
    if (!existsSync(path)) {
        return [];
    }
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw.records ?? [];
}
