import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDv1PlanningData } from "./data.js";
import { hydrateCartonsFromReferenceCatalog, hydrateOrderFromReferenceCatalog } from "./core/domain/reference-catalog.js";
import { soloShippingCostLookup } from "./core/domain/solo-shipping-costs.js";
import { JsonFileKnownCombinationStore } from "./core/planner/known-combinations.js";
import { planShipments } from "./core/planner/shipment-planner.js";
import { DEFAULT_WAREHOUSE_ORIGINS } from "./core/domain/shipping-rates.js";

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), "data");
const knownCombinationsPath = process.env.DV1_KNOWN_COMBINATIONS_PATH || "var/dv1-known-combinations.json";
let publishedRateConfigPromise;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function planDv1Order({ orderNumber, shopifyConfig, surpathConfig } = {}) {
  const liveData = await loadDv1PlanningData({ orderNumber, shopifyConfig, surpathConfig });
  if (!liveData) {
    return null;
  }

  const catalog = await readJson(join(dataDirectory, "reference-catalog.json"));
  const order = hydrateOrderFromReferenceCatalog(liveData.order, catalog);
  const inventory = {
    ...liveData.inventory,
    items: hydrateCartonsFromReferenceCatalog(liveData.inventory.items, catalog),
  };
  const soloShippingCosts = soloShippingCostLookup(
    await readJson(join(dataDirectory, "solo-shipping-costs.json")),
  );
  const rateConfig = await loadPublishedRateConfig();
  const plan = planShipments(order, inventory, {
    knownCombinations: new JsonFileKnownCombinationStore(knownCombinationsPath),
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
      "FedEx Ground costs are ranked with an origin-aware comparative planning model; this is a relative decision score, not a carrier quote.",
    ],
  };
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
