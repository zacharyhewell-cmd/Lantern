export class StaticSurpathInventoryAdapter {
    snapshot;
    constructor(snapshot) {
        this.snapshot = snapshot;
    }
    async getInventorySnapshot(warehouseId) {
        if (this.snapshot.warehouseId !== warehouseId) {
            return { warehouseId, items: [] };
        }
        return this.snapshot;
    }
}
export function inventoryBySku(items, defaultWarehouseId) {
    const bySku = new Map();
    for (const item of items) {
        const normalized = normalizeInventoryItemLocation(item, defaultWarehouseId);
        const existing = bySku.get(normalized.sku);
        if (existing) {
            existing.push(normalized);
        }
        else {
            bySku.set(normalized.sku, [normalized]);
        }
    }
    return bySku;
}
export function normalizeInventoryItemLocation(item, defaultWarehouseId) {
    return {
        ...item,
        warehouseId: item.warehouseId ?? defaultWarehouseId
    };
}
