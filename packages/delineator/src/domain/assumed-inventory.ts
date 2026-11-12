import type { InventorySnapshot, ReferenceCatalog } from "./types.js";

export const ASSUMED_AVAILABLE_QUANTITY = 999_999;

export function createAssumedAvailableInventory(
  catalog: ReferenceCatalog,
  warehouseId: string,
  available = ASSUMED_AVAILABLE_QUANTITY
): InventorySnapshot {
  return {
    warehouseId,
    items: [
      ...catalog.skus.map((sku) => ({
        sku: sku.sku,
        available
      })),
      ...catalog.cartons.map((carton) => ({
        sku: carton.sku,
        available,
        container: {
          innerDimensions: carton.innerDimensions,
          ...(carton.maxWeight ? { maxWeight: carton.maxWeight } : {})
        }
      }))
    ]
  };
}
