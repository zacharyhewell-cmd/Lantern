export function soloShippingCostLookup(catalog) {
    return new Map(catalog.costs.map((cost) => [cost.sku, cost]));
}
