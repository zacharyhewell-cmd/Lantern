import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDv1PlanningData } from "./data.js";
import {
  DEFAULT_WAREHOUSE_ORIGINS,
  hydrateCartonsFromReferenceCatalog,
  hydrateOrderFromReferenceCatalog,
  JsonFileKnownCombinationStore,
  planShipments,
  soloShippingCostLookup,
} from "@lantern/delineator";

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), "data");
export const dv1CatalogBaselinePath = join(dataDirectory, "reference-catalog.json");
export const dv1CostsBaselinePath = join(dataDirectory, "solo-shipping-costs.json");
export const dv1SourceSnapshotPath = fileURLToPath(new URL("../../var/dv1/source-snapshot.json", import.meta.url));
const knownCombinationsPath = process.env.DV1_KNOWN_COMBINATIONS_PATH || join(dataDirectory, "known-combinations.json");
export const historicalKnownCombinationsPath = join(dataDirectory, "historical-known-combinations.json");
let publishedRateConfigPromise;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function planDv1Order({ orderNumber, shopifyConfig, surpathConfig, knownCombinations } = {}) {
  const liveData = await loadDv1PlanningData({ orderNumber, shopifyConfig, surpathConfig });
  if (!liveData) {
    return null;
  }

  return planDv1Data(liveData, { knownCombinations });
}

export async function planDv1Data(liveData, { knownCombinations, sourceSnapshotPath = dv1SourceSnapshotPath } = {}) {
  const { referenceCatalog: catalog, soloShippingCosts: costs } = await loadSourceSnapshot(sourceSnapshotPath);
  const order = hydrateOrderFromReferenceCatalog(liveData.order, catalog);
  const inventory = {
    ...liveData.inventory,
    items: hydrateCartonsFromReferenceCatalog(liveData.inventory.items, catalog),
  };
  const soloShippingCosts = soloShippingCostLookup(costs);
  const rateConfig = await loadPublishedRateConfig();
  const plan = planShipments(order, inventory, {
    knownCombinations: knownCombinations || new JsonFileKnownCombinationStore(knownCombinationsPath, [historicalKnownCombinationsPath]),
    soloShippingCosts,
    catalogSkus: new Set(catalog.skus.map((sku) => sku.sku)),
    rateConfig,
  });

  return {
    order,
    plan,
    catalogSnapshot: catalog.generatedFrom,
    warnings: [
      ...(liveData.warnings || []),
      "FedEx Ground and Express Saver are compared with published list-rate tables and origin zone maps; this is a comparative planning model, not a carrier quote.",
    ],
  };
}

async function loadSourceSnapshot(snapshotPath) {
  try {
    return await readJson(snapshotPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const [referenceCatalog, soloShippingCosts] = await Promise.all([
    readJson(dv1CatalogBaselinePath),
    readJson(dv1CostsBaselinePath),
  ]);
  return { referenceCatalog, soloShippingCosts };
}

async function loadPublishedRateConfig() {
  if (!publishedRateConfigPromise) {
    publishedRateConfigPromise = Promise.all([
      readJson(join(dataDirectory, "rates/fedex-ground-2026.json")),
      readJson(join(dataDirectory, "rates/fedex-express-saver-2026.json")),
      readJson(join(dataDirectory, "zones/fedex-zone-91744-2022.json")),
      readJson(join(dataDirectory, "zones/fedex-zone-nj-rsr7-2022.json")),
      readJson(join(dataDirectory, "zones/fedex-zone-la-hn1a-2022.json")),
      readJson(join(dataDirectory, "zones/fedex-zone-ga-vlh1-2022.json")),
    ]).then(([ground, saver, laSpiZoneMap, njRsr7ZoneMap, laHn1aZoneMap, gaVlh1ZoneMap]) => ({
      serviceLevel: "FEDEX_GROUND",
      origins: DEFAULT_WAREHOUSE_ORIGINS,
      rateCharts: {
        FEDEX_GROUND: ground,
        FEDEX_EXPRESS_SAVER: saver,
      },
      zoneMaps: {
        "LA-SPI1": laSpiZoneMap,
        "LA-WLW2": laSpiZoneMap,
        "SPLALS1": laSpiZoneMap,
        "NJ-RSR7": njRsr7ZoneMap,
        "LA-HN1A": laHn1aZoneMap,
        "GA-VLH1": gaVlh1ZoneMap,
      },
      compareServiceLevels: ["FEDEX_GROUND", "FEDEX_EXPRESS_SAVER"],
    }));
  }
  return publishedRateConfigPromise;
}
