import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDv1PlanningData } from "./data.js";
import { hydrateCartonsFromReferenceCatalog, hydrateOrderFromReferenceCatalog } from "./core/domain/reference-catalog.js";
import { soloShippingCostLookup } from "./core/domain/solo-shipping-costs.js";
import { JsonFileKnownCombinationStore } from "./core/planner/known-combinations.js";
import { planShipments } from "./core/planner/shipment-planner.js";

const dataDirectory = join(dirname(fileURLToPath(import.meta.url)), "data");
const knownCombinationsPath = process.env.DV1_KNOWN_COMBINATIONS_PATH || "var/dv1-known-combinations.json";

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
  const plan = planShipments(order, inventory, {
    knownCombinations: new JsonFileKnownCombinationStore(knownCombinationsPath),
    soloShippingCosts,
  });

  return {
    order,
    plan,
    warnings: liveData.warnings || [],
  };
}
