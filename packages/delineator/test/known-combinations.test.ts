import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BufferedKnownCombinationStore,
  JsonFileKnownCombinationStore,
  createKnownCombinationRecord,
  type KnownCombinationRecord,
  type KnownCombinationSink
} from "../src/planner/known-combinations.js";

function record(): KnownCombinationRecord {
  return createKnownCombinationRecord(
    "sku-key",
    [{ id: "line-1", sku: "AA-1", quantity: 1, dimensions: { length: 1, width: 1, height: 1, unit: "in" } }],
    "ABOX-1",
    { length: 2, width: 2, height: 2, unit: "in" },
    { warehouseId: "LA-SPI1", sourceOrderNumber: "WS-#10001" }
  );
}

class MemorySink implements KnownCombinationSink {
  rows: KnownCombinationRecord[] = [];
  async readAll(): Promise<KnownCombinationRecord[]> { return [...this.rows]; }
  async append(records: KnownCombinationRecord[]): Promise<void> { this.rows.push(...records); }
}

test("buffered known-combination store persists locally and flushes new records in a batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delineator-known-"));
  const localPath = join(directory, "known.json");
  const sink = new MemorySink();
  const store = new BufferedKnownCombinationStore(new JsonFileKnownCombinationStore(localPath), sink);
  store.put(record());

  assert.equal((await store.flushPending()).persisted, 1);
  assert.equal(sink.rows.length, 1);
  assert.equal(JSON.parse(await readFile(localPath, "utf8")).records.length, 1);

  assert.equal((await store.flushPending()).attempted, 0);
});

test("buffered known-combination store hydrates remote records into the local lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delineator-known-"));
  const sink = new MemorySink();
  sink.rows.push(record());
  const store = new BufferedKnownCombinationStore(
    new JsonFileKnownCombinationStore(join(directory, "known.json")),
    sink
  );

  assert.equal(await store.hydrateFromRemote(), 1);
  assert.equal(store.getAll("sku-key").length, 1);
});
