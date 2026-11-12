import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { lookupFedexRate, lookupFedexZone, selectLowestPublishedRate, type FedexRateChart, type FedexZoneMap } from "../src/domain/fedex-rate-chart.js";
import { createFedexGroundProxyEstimator } from "../src/domain/shipping-rates.js";
import { DEFAULT_WAREHOUSE_ORIGINS } from "../src/domain/shipping-rates.js";

test("ingested Ground chart preserves the domestic zone table and effective date", async () => {
  const chart = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-ground-2026.json", "utf8")) as FedexRateChart;

  assert.equal(chart.serviceLevel, "FEDEX_GROUND");
  assert.equal(chart.effectiveDate, "2026-01-05");
  assert.deepEqual(chart.zoneLabels, ["Zone 2", "Zone 3", "Zone 4", "Zone 5", "Zone 6", "Zone 7", "Zone 8"]);
  assert.equal(chart.rows.length, 150);
  assert.equal(lookupFedexRate(chart, 1, "Zone 2"), 11.99);
  assert.equal(lookupFedexRate(chart, 20, "Zone 2"), 19.36);
  assert.equal(lookupFedexRate(chart, 58, "Zone 2"), 29.95);
});

test("rate lookup does not invent rates outside the supplied chart", async () => {
  const chart = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-ground-2026.json", "utf8")) as FedexRateChart;

  assert.equal(lookupFedexRate(chart, 151, "Zone 2"), undefined);
  assert.equal(lookupFedexRate(chart, 1, "Zone 99"), undefined);
});

test("ingested Express Saver chart preserves package and multiweight schedules", async () => {
  const chart = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-express-saver-2026.json", "utf8")) as FedexRateChart;

  assert.equal(chart.serviceLevel, "FEDEX_EXPRESS_SAVER");
  assert.equal(chart.effectiveDate, "2026-01-05");
  assert.equal(chart.rows.length, 150);
  assert.equal(lookupFedexRate(chart, 1, "Zone 2"), 23.84);
  assert.equal(lookupFedexRate(chart, 66, "Zone 2"), 127.18);
  assert.deepEqual(chart.multiweightRows?.map((row) => row.minWeightLb), [100, 500, 1000, 2000]);
  assert.equal(chart.multiweightRows?.[0]?.ratePerLbUsd["Zone 2"], 1.85);
});

test("published service comparison selects the lower available service rate", async () => {
  const ground = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-ground-2026.json", "utf8")) as FedexRateChart;
  const saver = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-express-saver-2026.json", "utf8")) as FedexRateChart;

  assert.deepEqual(selectLowestPublishedRate([ground, saver], 1, "Zone 2"), {
    serviceLevel: "FEDEX_GROUND",
    rateUsd: 11.99
  });
});

test("91744 zone chart resolves contiguous and service-specific destinations", async () => {
  const zoneMap = JSON.parse(await readFile("../../src/dv1/data/zones/fedex-zone-91744-2022.json", "utf8")) as FedexZoneMap;

  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_GROUND"), 2);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_EXPRESS_SAVER"), 2);
  assert.equal(lookupFedexZone(zoneMap, "30548", "FEDEX_GROUND"), 8);
  assert.equal(lookupFedexZone(zoneMap, "96744", "FEDEX_GROUND"), 9);
  assert.equal(lookupFedexZone(zoneMap, "96744", "FEDEX_EXPRESS_SAVER"), 10);
  assert.equal(lookupFedexZone(zoneMap, "00000", "FEDEX_GROUND"), undefined);
});

test("published chart scoring uses the LA-SPI1 zone map and compares services", async () => {
  const ground = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-ground-2026.json", "utf8")) as FedexRateChart;
  const saver = JSON.parse(await readFile("../../src/dv1/data/rates/fedex-express-saver-2026.json", "utf8")) as FedexRateChart;
  const zoneMap = JSON.parse(await readFile("../../src/dv1/data/zones/fedex-zone-91744-2022.json", "utf8")) as FedexZoneMap;
  const estimator = createFedexGroundProxyEstimator({
    serviceLevel: "FEDEX_GROUND",
    origins: DEFAULT_WAREHOUSE_ORIGINS,
    rateCharts: { FEDEX_GROUND: ground, FEDEX_EXPRESS_SAVER: saver },
    zoneMaps: { "LA-SPI1": zoneMap },
    compareServiceLevels: ["FEDEX_GROUND", "FEDEX_EXPRESS_SAVER"]
  });

  assert.equal(estimator({
    order: { orderId: "order", orderNumber: "WS-#1", warehouseId: "LA-SPI1", destination: { postalCode: "90703", countryCode: "US" }, lines: [] },
    lines: [],
    containerDimensions: { length: 865, width: 500, height: 305, unit: "mm" },
    packageWeight: { value: 1, unit: "lb" },
    warehouseId: "LA-SPI1"
  }), 33.46);
});

test("NJ-RSR7 zone chart resolves its origin range and destination zones", async () => {
  const zoneMap = JSON.parse(await readFile("../../src/dv1/data/zones/fedex-zone-nj-rsr7-2022.json", "utf8")) as FedexZoneMap;

  assert.deepEqual(zoneMap.originZipRanges, ["08500-08699"]);
  assert.equal(lookupFedexZone(zoneMap, "08691", "FEDEX_GROUND"), 2);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_GROUND"), 8);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_EXPRESS_SAVER"), 8);
});

test("LA-HN1A zone chart resolves its origin range and destination zones", async () => {
  const zoneMap = JSON.parse(await readFile("../../src/dv1/data/zones/fedex-zone-la-hn1a-2022.json", "utf8")) as FedexZoneMap;

  assert.deepEqual(zoneMap.originZipRanges, ["92300-92599"]);
  assert.equal(lookupFedexZone(zoneMap, "92337", "FEDEX_GROUND"), 2);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_GROUND"), 2);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_EXPRESS_SAVER"), 2);
});

test("GA-VLH1 zone chart resolves its origin range and destination zones", async () => {
  const zoneMap = JSON.parse(await readFile("../../src/dv1/data/zones/fedex-zone-ga-vlh1-2022.json", "utf8")) as FedexZoneMap;

  assert.deepEqual(zoneMap.originZipRanges, ["30500-30599"]);
  assert.equal(lookupFedexZone(zoneMap, "30548", "FEDEX_GROUND"), 2);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_GROUND"), 8);
  assert.equal(lookupFedexZone(zoneMap, "90703", "FEDEX_EXPRESS_SAVER"), 8);
});
