import type { InventoryItem, InventorySnapshot } from "./types.js";

export interface SurpathInventoryAdapter {
  getInventorySnapshot(warehouseId: string): Promise<InventorySnapshot>;
}

export class StaticSurpathInventoryAdapter implements SurpathInventoryAdapter {
  constructor(private readonly snapshot: InventorySnapshot) {}

  async getInventorySnapshot(warehouseId: string): Promise<InventorySnapshot> {
    if (this.snapshot.warehouseId !== warehouseId) {
      return { warehouseId, items: [] };
    }

    return this.snapshot;
  }
}

export function inventoryBySku(items: InventoryItem[], defaultWarehouseId: string): Map<string, InventoryItem[]> {
  const bySku = new Map<string, InventoryItem[]>();

  for (const item of items) {
    const normalized = normalizeInventoryItemLocation(item, defaultWarehouseId);
    const existing = bySku.get(normalized.sku);

    if (existing) {
      existing.push(normalized);
    } else {
      bySku.set(normalized.sku, [normalized]);
    }
  }

  return bySku;
}

export function normalizeInventoryItemLocation(item: InventoryItem, defaultWarehouseId: string): InventoryItem {
  return {
    ...item,
    warehouseId: item.warehouseId ?? defaultWarehouseId
  };
}
