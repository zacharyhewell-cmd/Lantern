import type { SoloShippingCostCatalog, SoloShippingCostReference } from "./types.js";

export type SoloShippingCostLookup = Map<string, SoloShippingCostReference>;

export function soloShippingCostLookup(catalog: SoloShippingCostCatalog): SoloShippingCostLookup {
  return new Map(catalog.costs.map((cost) => [cost.sku, cost]));
}
