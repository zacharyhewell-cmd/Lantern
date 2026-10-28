export const DELINEATOR_SKU_PREFIX = "AA";
export const CARTON_SKU_PREFIX = "ABOX";
export function hydrateOrderFromReferenceCatalog(order, catalog) {
    const referenceBySku = new Map(catalog.skus.map((sku) => [sku.sku, sku]));
    return {
        ...order,
        lines: order.lines.map((line) => {
            const reference = referenceBySku.get(line.sku);
            if (!reference) {
                return line;
            }
            return {
                ...line,
                dimensions: line.dimensions ?? reference.dimensions,
                weight: line.weight ?? reference.weight,
                packGroup: line.packGroup ?? reference.packGroup,
                canPackWith: line.canPackWith ?? reference.canPackWith
            };
        })
    };
}
export function hydrateCartonsFromReferenceCatalog(inventoryItems, catalog) {
    const cartonBySku = new Map(catalog.cartons.map((carton) => [carton.sku, carton]));
    return inventoryItems.map((item) => {
        if (item.container || !item.sku.startsWith(CARTON_SKU_PREFIX)) {
            return item;
        }
        const reference = cartonBySku.get(item.sku);
        return reference ? { ...item, container: cartonToContainer(reference) } : item;
    });
}
export function isDelineatorSku(line) {
    return line.sku.startsWith(DELINEATOR_SKU_PREFIX);
}
export function expandCompactSkuReference(reference) {
    const expandedSkus = expandCompactSku(reference.sku);
    if (expandedSkus.length === 1 && expandedSkus[0] === reference.sku) {
        return [reference];
    }
    return expandedSkus.map((sku) => ({
        ...reference,
        sku,
        sourceNote: `${reference.sourceNote ?? "Imported from source catalog."} Expanded from source SKU ${reference.sku}.`
    }));
}
export function expandCompactSku(sku) {
    if (sku.includes("/")) {
        return expandSkuList(sku);
    }
    return expandSkuRange(sku);
}
function cartonToContainer(carton) {
    return {
        innerDimensions: carton.innerDimensions,
        maxWeight: carton.maxWeight
    };
}
function expandSkuList(sku) {
    const [first, ...rest] = sku.split("/");
    const firstMatch = first.match(/^([A-Z]+)(\d+)([A-Z])$/);
    if (!firstMatch) {
        return [sku];
    }
    const [, prefix, firstDigits] = firstMatch;
    const width = firstDigits.length;
    return [
        first,
        ...rest.map((part) => {
            const partMatch = part.match(/^(\d+)([A-Z])$/);
            return partMatch ? `${prefix}${partMatch[1].padStart(width, "0")}${partMatch[2]}` : part;
        })
    ];
}
function expandSkuRange(sku) {
    const match = sku.match(/^([A-Z]+)(\d+)([A-Z])-(\d+)([A-Z])$/);
    if (!match) {
        return [sku];
    }
    const [, prefix, startDigits, startSuffix, endDigits, endSuffix] = match;
    if (startSuffix !== endSuffix) {
        return [sku];
    }
    const start = Number(startDigits);
    const endPrefix = startDigits.slice(0, startDigits.length - endDigits.length);
    const end = Number(`${endPrefix}${endDigits}`);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
        return [sku];
    }
    return Array.from({ length: end - start + 1 }, (_, index) => {
        const digits = String(start + index).padStart(startDigits.length, "0");
        return `${prefix}${digits}${startSuffix}`;
    });
}
