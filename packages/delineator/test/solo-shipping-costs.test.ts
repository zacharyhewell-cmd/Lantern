import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("refreshed solo shipping catalog includes paid AA tracking baselines and -D variants", async () => {
  const catalog = JSON.parse(await readFile("../../src/dv1/data/solo-shipping-costs.json", "utf8")) as {
    generatedFrom: { sheetId: string; singleSkuTrackingObservations: number; mixedSkuTrackingObservations: number; includesDVariants: boolean };
    costs: Array<{ sku: string; shipmentCount: number }>;
  };

  assert.equal(catalog.generatedFrom.sheetId, "qFDTIF");
  assert.equal(catalog.generatedFrom.singleSkuTrackingObservations, 64101);
  assert.equal(catalog.generatedFrom.mixedSkuTrackingObservations, 940);
  assert.equal(catalog.generatedFrom.includesDVariants, true);
  assert.ok(catalog.costs.every((cost) => cost.sku.startsWith("AA") && cost.shipmentCount > 0));
  assert.ok(catalog.costs.some((cost) => cost.sku.endsWith("-D")));
});
