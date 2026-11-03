import { packRigidItems, requiredDimensions, totalLineVolume, volume } from "../domain/geometry.js";
import { isDelineatorSku } from "../domain/reference-catalog.js";
import { inventoryBySku, normalizeInventoryItemLocation } from "../domain/surpath-adapter.js";
import { createFedexGroundProxyEstimator, resolveWarehouseOrigin } from "../domain/shipping-rates.js";
import { createKnownCombinationRecord, knownCombinationKey, sameDimensions } from "./known-combinations.js";
const MAX_EXACT_OPTIMIZATION_UNITS = 16;
const MAX_EXACT_ALLOCATION_UNITS = 12;
const MAX_ALLOCATION_CANDIDATES = 2_000;
const DIMENSIONAL_WEIGHT_DIVISOR_IN = 139;
const CARTON_BASE_COST_USD = 10;
const CARTON_COST_PER_DIM_WEIGHT_LB_USD = 2.95;
const FALLBACK_SOLO_BASE_COST_USD = 15;
const FALLBACK_SOLO_COST_PER_DIM_WEIGHT_LB_USD = CARTON_COST_PER_DIM_WEIGHT_LB_USD;
export function planShipments(order, inventory, options = {}) {
    const exceptions = [];
    const baseRateEstimator = options.rateEstimator ?? (options.rateConfig
        ? createFedexGroundProxyEstimator(options.rateConfig)
        : undefined);
    const rateEstimator = baseRateEstimator
        ? (context) => baseRateEstimator({
            ...context,
            destination: order.destination,
            origin: resolveWarehouseOrigin(context.warehouseId, options.rateConfig?.origins),
            serviceLevel: options.rateConfig?.serviceLevel ?? "FEDEX_GROUND",
            packageWeight: context.packageWeight ?? totalWeight(context.lines)
        })
        : undefined;
    const normalizedInventory = inventory.items.map((item) => normalizeInventoryItemLocation(item, inventory.warehouseId));
    const availableBySku = inventoryBySku(normalizedInventory, inventory.warehouseId);
    const containers = normalizedInventory
        .filter((item) => Boolean(item.container))
        .filter((item) => item.available > 0)
        .sort((a, b) => volume(a.container.innerDimensions) - volume(b.container.innerDimensions));
    const remainingContainerAvailability = new Map(containers.map((container) => [containerAvailabilityKey(container), container.available]));
    const ignoredLines = order.lines.filter((line) => !isDelineatorSku(line)).map(toShipmentLine);
    if (options.rateConfig) {
        if (!order.destination?.postalCode || !order.destination.countryCode) {
            exceptions.push({
                code: "MISSING_RATE_DATA",
                message: "Shopify did not provide a complete destination postal code and country for FedEx Ground rating.",
                orderLineIds: order.lines.map((line) => line.id)
            });
        }
        const warehouseIds = new Set(normalizedInventory.filter((item) => item.available > 0).map((item) => item.warehouseId ?? inventory.warehouseId));
        warehouseIds.add(order.warehouseId);
        for (const warehouseId of warehouseIds) {
            if (!resolveWarehouseOrigin(warehouseId, options.rateConfig.origins)) {
                exceptions.push({
                    code: "MISSING_RATE_DATA",
                    message: `No shipping origin address is configured for Surpath warehouse ${warehouseId}.`,
                    orderLineIds: order.lines.map((line) => line.id)
                });
            }
        }
    }
    const eligibleLines = [];
    const inventoryByLineId = new Map();
    for (const line of order.lines.filter(isDelineatorSku)) {
        if (options.catalogSkus && !options.catalogSkus.has(line.sku)) {
            exceptions.push({
                code: "MISSING_REFERENCE_DATA",
                message: `${line.sku} is not included in the current SKU catalog snapshot. Operator direction is required before planning this line.`,
                orderLineIds: [line.id]
            });
            continue;
        }
        if (!line.dimensions) {
            exceptions.push({
                code: "MISSING_REFERENCE_DATA",
                message: `${line.sku} needs dimensions in the Delineator reference catalog.`,
                orderLineIds: [line.id]
            });
            continue;
        }
        const itemInventory = availableBySku.get(line.sku)?.filter((item) => item.available > 0) ?? [];
        const totalAvailable = itemInventory.reduce((sum, item) => sum + item.available, 0);
        if (itemInventory.length === 0) {
            exceptions.push({
                code: "MISSING_ITEM_INVENTORY",
                message: `${line.sku} is not present in available Surpath inventory.`,
                orderLineIds: [line.id]
            });
            continue;
        }
        if (totalAvailable < line.quantity) {
            exceptions.push({
                code: "INSUFFICIENT_ITEM_INVENTORY",
                message: `${line.sku} needs ${line.quantity}, but Surpath only shows ${totalAvailable} available across all warehouses.`,
                orderLineIds: [line.id]
            });
            continue;
        }
        eligibleLines.push(line);
        inventoryByLineId.set(line.id, itemInventory);
    }
    const shipments = [];
    const packableGroups = groupByPackCompatibility(eligibleLines, exceptions);
    for (const group of packableGroups) {
        const selected = selectBestAllocation(group, inventoryByLineId, containers, order, options.knownCombinations, options.soloShippingCosts, rateEstimator, remainingContainerAvailability);
        exceptions.push(...selected.exceptions);
        recordKnownCombinations(selected.shipments, group, containers, options.knownCombinations);
        for (const shipment of selected.shipments) {
            if (!shipment.containerSku)
                continue;
            const key = `${shipment.warehouseId}:${shipment.containerSku}`;
            remainingContainerAvailability.set(key, (remainingContainerAvailability.get(key) ?? 0) - 1);
        }
        for (const shipment of selected.shipments) {
            const shipmentIndex = shipments.length + 1;
            shipments.push({
                ...shipment,
                shipmentIndex,
                fulfillmentName: fulfillmentName(order.orderNumber, shipmentIndex)
            });
        }
    }
    if (eligibleLines.length === 0 && exceptions.length === 0) {
        return {
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            warehouseId: order.warehouseId,
            status: "ready",
            shipments: [],
            exceptions,
            ignoredLines
        };
    }
    return {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        warehouseId: order.warehouseId,
        status: exceptions.length === 0 ? "ready" : "needs_review",
        shipments,
        exceptions,
        ignoredLines
    };
}
function selectBestAllocation(group, inventoryByLineId, containers, order, knownCombinations, soloShippingCosts, rateEstimator, remainingContainerAvailability) {
    const candidates = enumerateAllocationCandidates(group, inventoryByLineId, order.warehouseId);
    let best = null;
    for (const allocation of candidates) {
        const shipments = [];
        const exceptions = [];
        for (const [warehouseId, lines] of sortWarehouseEntries(allocation, order.warehouseId)) {
            const warehouseContainers = containers.filter((container) => container.warehouseId === warehouseId);
            const remainingContainers = new Map(warehouseContainers.map((container) => [
                container.sku,
                remainingContainerAvailability?.get(containerAvailabilityKey(container)) ?? container.available
            ]));
            const matchingUnitContainers = warehouseContainers.filter((container) => container.container.innerDimensions.unit === lines[0]?.dimensions?.unit);
            const usableContainers = warehouseContainers.length > 0 && matchingUnitContainers.length === 0
                ? []
                : matchingUnitContainers;
            if (warehouseContainers.length > 0 && matchingUnitContainers.length === 0) {
                exceptions.push({
                    code: "UNIT_MISMATCH",
                    message: `No available cartons in ${warehouseId} use the same dimension unit as ${lines
                        .map((line) => line.sku)
                        .join(", ")}.`,
                    orderLineIds: lines.map((line) => line.id)
                });
            }
            const optimized = optimizeGroupIntoShipments(lines, usableContainers, remainingContainers, order.orderNumber, order, warehouseId, readOnlyKnownCombinationStore(knownCombinations), soloShippingCosts, rateEstimator, shipments.length);
            shipments.push(...optimized.shipments);
            for (const line of optimized.unpackedLines) {
                shipments.push(singleLineShipment(order.orderNumber, shipments.length + 1, warehouseId, line, soloShippingCosts?.get(line.sku)));
            }
        }
        const score = scoreShipmentPlan(shipments, group, containers, order, soloShippingCosts, rateEstimator);
        if (!best ||
            exceptions.length < best.exceptions.length ||
            (exceptions.length === best.exceptions.length && (score < best.score || (score === best.score && shipments.length < best.shipments.length)))) {
            best = { shipments, score, exceptions };
        }
    }
    return best ?? { shipments: [], score: Number.POSITIVE_INFINITY, exceptions: [] };
}
function readOnlyKnownCombinationStore(store) {
    if (!store)
        return undefined;
    return {
        get: (key) => store.get(key),
        put: () => undefined
    };
}
function containerAvailabilityKey(container) {
    return `${container.warehouseId}:${container.sku}`;
}
function enumerateAllocationCandidates(group, inventoryByLineId, preferredWarehouseId) {
    const unitCount = group.reduce((sum, line) => sum + line.quantity, 0);
    if (unitCount > MAX_EXACT_ALLOCATION_UNITS) {
        return [greedyAllocation(group, inventoryByLineId, preferredWarehouseId)];
    }
    let candidates = [new Map()];
    for (const line of group) {
        const options = enumerateLineAllocations(line, inventoryByLineId.get(line.id) ?? [], preferredWarehouseId);
        const expanded = [];
        for (const candidate of candidates) {
            for (const option of options) {
                const merged = cloneAllocation(candidate);
                for (const allocated of option) {
                    const lines = merged.get(allocated.warehouseId) ?? [];
                    lines.push(allocated.line);
                    merged.set(allocated.warehouseId, lines);
                }
                expanded.push(merged);
                if (expanded.length >= MAX_ALLOCATION_CANDIDATES) {
                    break;
                }
            }
            if (expanded.length >= MAX_ALLOCATION_CANDIDATES) {
                break;
            }
        }
        candidates = expanded;
    }
    return candidates;
}
function enumerateLineAllocations(line, inventoryItems, preferredWarehouseId) {
    const availability = new Map();
    for (const item of inventoryItems) {
        const warehouseId = item.warehouseId ?? preferredWarehouseId;
        availability.set(warehouseId, (availability.get(warehouseId) ?? 0) + item.available);
    }
    const warehouses = [...availability.keys()].sort((a, b) => {
        if (a === preferredWarehouseId && b !== preferredWarehouseId)
            return -1;
        if (b === preferredWarehouseId && a !== preferredWarehouseId)
            return 1;
        return a.localeCompare(b);
    });
    const options = [];
    const visit = (index, remaining, allocations) => {
        if (index === warehouses.length) {
            if (remaining === 0) {
                options.push([...allocations.entries()]
                    .filter(([, quantity]) => quantity > 0)
                    .map(([warehouseId, quantity]) => ({ warehouseId, line: { ...line, quantity } })));
            }
            return;
        }
        const warehouseId = warehouses[index];
        const available = availability.get(warehouseId) ?? 0;
        const remainingCapacity = warehouses
            .slice(index + 1)
            .reduce((sum, candidate) => sum + (availability.get(candidate) ?? 0), 0);
        const minimum = Math.max(0, remaining - remainingCapacity);
        const maximum = Math.min(available, remaining);
        for (let quantity = minimum; quantity <= maximum; quantity += 1) {
            if (quantity > 0)
                allocations.set(warehouseId, quantity);
            visit(index + 1, remaining - quantity, allocations);
            allocations.delete(warehouseId);
        }
    };
    visit(0, line.quantity, new Map());
    return options;
}
function greedyAllocation(group, inventoryByLineId, preferredWarehouseId) {
    const allocation = new Map();
    for (const line of group) {
        for (const allocated of allocateLineByWarehouse(line, inventoryByLineId.get(line.id) ?? [], preferredWarehouseId)) {
            const lines = allocation.get(allocated.warehouseId) ?? [];
            lines.push(allocated.line);
            allocation.set(allocated.warehouseId, lines);
        }
    }
    return allocation;
}
function cloneAllocation(allocation) {
    return new Map([...allocation.entries()].map(([warehouseId, lines]) => [warehouseId, [...lines]]));
}
function scoreShipmentPlan(shipments, sourceLines, containers, order, soloShippingCosts, rateEstimator) {
    return shipments.reduce((sum, shipment) => {
        const lines = shipment.lines.flatMap((shipmentLine) => {
            const source = sourceLines.find((line) => line.id === shipmentLine.orderLineId);
            return source ? [{ ...source, quantity: shipmentLine.quantity }] : [];
        });
        const container = shipment.containerSku
            ? containers.find((candidate) => candidate.sku === shipment.containerSku && candidate.warehouseId === shipment.warehouseId)
            : undefined;
        const defaultProxyCost = shipment.containerSku
            ? (container ? cartonShipmentScore(container.container.innerDimensions) : Number.POSITIVE_INFINITY)
            : lines.reduce((lineSum, line) => lineSum + soloShipmentScore(requiredDimensions(line), soloShippingCosts?.get(line.sku)) * line.quantity, 0);
        if (rateEstimator) {
            return sum + rateEstimator({
                order,
                shipment,
                lines,
                containerDimensions: container?.container.innerDimensions,
                packageDimensions: container?.container.innerDimensions ?? (lines.length === 1 ? requiredDimensions(lines[0]) : undefined),
                warehouseId: shipment.warehouseId,
                packageWeight: totalWeight(lines),
                defaultProxyCost
            });
        }
        if (shipment.containerSku) {
            return sum + (container ? cartonShipmentScore(container.container.innerDimensions) : Number.POSITIVE_INFINITY);
        }
        return sum + defaultProxyCost;
    }, 0);
}
function totalWeight(lines) {
    const pounds = lines.reduce((sum, line) => sum + (line.weight?.value ?? 0) * line.quantity, 0);
    return pounds > 0 ? { value: pounds, unit: "lb" } : undefined;
}
function shipmentCandidateScore(lines, containerSku, containerDimensions, order, warehouseId, rateEstimator, defaultProxyCost) {
    if (!rateEstimator)
        return defaultProxyCost;
    return rateEstimator({
        order,
        shipment: {
            shipmentIndex: 0,
            fulfillmentName: "candidate",
            warehouseId,
            containerSku,
            lines: lines.map(toShipmentLine),
            reasons: []
        },
        lines,
        containerDimensions,
        packageDimensions: containerDimensions ?? (lines.length === 1 ? requiredDimensions(lines[0]) : undefined),
        warehouseId,
        packageWeight: totalWeight(lines),
        defaultProxyCost
    });
}
function recordKnownCombinations(shipments, sourceLines, containers, knownCombinations) {
    if (!knownCombinations)
        return;
    for (const shipment of shipments) {
        if (!shipment.containerSku)
            continue;
        const container = containers.find((candidate) => candidate.sku === shipment.containerSku && candidate.warehouseId === shipment.warehouseId);
        if (!container)
            continue;
        const lines = shipment.lines.flatMap((shipmentLine) => {
            const source = sourceLines.find((line) => line.id === shipmentLine.orderLineId);
            return source ? [{ ...source, quantity: shipmentLine.quantity }] : [];
        });
        if (lines.length > 0) {
            const key = knownCombinationKey(lines);
            if (!knownCombinations.get(key)) {
                knownCombinations.put(createKnownCombinationRecord(key, lines, container.sku, container.container.innerDimensions));
            }
        }
    }
}
function sortWarehouseEntries(lineGroups, preferredWarehouseId) {
    return [...lineGroups.entries()].sort(([a], [b]) => {
        if (a === preferredWarehouseId && b !== preferredWarehouseId) {
            return -1;
        }
        if (b === preferredWarehouseId && a !== preferredWarehouseId) {
            return 1;
        }
        return a.localeCompare(b);
    });
}
function allocateLineByWarehouse(line, inventoryItems, preferredWarehouseId) {
    let remainingQuantity = line.quantity;
    const allocations = [];
    const sortedInventory = [...inventoryItems].sort((a, b) => {
        if (a.warehouseId === preferredWarehouseId && b.warehouseId !== preferredWarehouseId) {
            return -1;
        }
        if (b.warehouseId === preferredWarehouseId && a.warehouseId !== preferredWarehouseId) {
            return 1;
        }
        return b.available - a.available;
    });
    for (const item of sortedInventory) {
        if (remainingQuantity <= 0) {
            break;
        }
        const warehouseId = item.warehouseId ?? preferredWarehouseId;
        const quantity = Math.min(remainingQuantity, item.available);
        remainingQuantity -= quantity;
        allocations.push({
            warehouseId,
            line: {
                ...line,
                quantity
            }
        });
    }
    return allocations;
}
function findKnownCombinationContainer(combinationKey, containers, remainingContainers, knownCombinations) {
    const knownCombination = knownCombinations?.get(combinationKey);
    if (!knownCombination) {
        return null;
    }
    return (containers.find((container) => container.sku === knownCombination.cartonSku &&
        (remainingContainers.get(container.sku) ?? 0) > 0 &&
        sameDimensions(container.container.innerDimensions, knownCombination.cartonDimensions)) ?? null);
}
function groupByPackCompatibility(lines, exceptions) {
    const groups = [];
    const assigned = new Set();
    for (const line of lines) {
        if (line.canPackWith?.length === 0) {
            assigned.add(line.id);
            groups.push([line]);
        }
    }
    for (const line of lines) {
        if (assigned.has(line.id) || !line.canPackWith || line.canPackWith.length === 0) {
            continue;
        }
        const compatible = lines.filter((candidate) => !assigned.has(candidate.id) &&
            candidate.id !== line.id &&
            line.canPackWith?.includes(candidate.sku) &&
            (!candidate.canPackWith || candidate.canPackWith.includes(line.sku)));
        if (compatible.length === 0) {
            exceptions.push({
                code: "PACKING_RULE_BLOCKED",
                message: `${line.sku} has pack-together restrictions and no compatible order lines.`,
                orderLineIds: [line.id]
            });
            assigned.add(line.id);
            groups.push([line]);
            continue;
        }
        const group = [line, ...compatible];
        group.forEach((groupLine) => assigned.add(groupLine.id));
        groups.push(group);
    }
    const unrestricted = lines.filter((line) => !assigned.has(line.id) && !line.canPackWith);
    if (unrestricted.length > 0) {
        unrestricted.forEach((line) => assigned.add(line.id));
        groups.push(unrestricted);
    }
    return groups;
}
function optimizeGroupIntoShipments(group, containers, remainingContainers, orderNumber, order, warehouseId, knownCombinations, soloShippingCosts, rateEstimator, startingShipmentCount) {
    const exactResult = optimizeExactGroupIntoShipments(group, containers, remainingContainers, orderNumber, order, warehouseId, knownCombinations, soloShippingCosts, rateEstimator, startingShipmentCount);
    if (exactResult) {
        return exactResult;
    }
    const shipments = [];
    let remainingUnits = expandPackingUnits(group, warehouseId);
    while (remainingUnits.length > 0) {
        const candidate = findBestPackedCartonCandidate(remainingUnits, containers, remainingContainers, knownCombinations, soloShippingCosts, rateEstimator, order, warehouseId);
        if (!candidate) {
            break;
        }
        remainingContainers.set(candidate.container.sku, (remainingContainers.get(candidate.container.sku) ?? 0) - 1);
        if (!candidate.usedKnownCombination) {
            knownCombinations?.put(createKnownCombinationRecord(knownCombinationKey(candidate.lines), candidate.lines, candidate.container.sku, candidate.container.container.innerDimensions));
        }
        const shipmentIndex = startingShipmentCount + shipments.length + 1;
        shipments.push({
            shipmentIndex,
            fulfillmentName: fulfillmentName(orderNumber, shipmentIndex),
            warehouseId,
            containerSku: candidate.container.sku,
            lines: candidate.lines.map(toShipmentLine),
            reasons: shipmentReasons(candidate.lines, candidate.container.sku, warehouseId, candidate.usedKnownCombination, candidate.fillRatio)
        });
        const packedUnitIds = new Set(candidate.units.map((unit) => unit.unitId));
        remainingUnits = remainingUnits.filter((unit) => !packedUnitIds.has(unit.unitId));
    }
    return {
        shipments,
        unpackedLines: unitsToOrderLines(remainingUnits)
    };
}
function findBestPackedCartonCandidate(units, containers, remainingContainers, knownCombinations, soloShippingCosts, rateEstimator, order, warehouseId) {
    const subsets = candidateUnitSubsets(units);
    let best = null;
    for (const subset of subsets) {
        if (subset.length < 2) {
            continue;
        }
        const lines = unitsToOrderLines(subset);
        const requiredVolume = totalLineVolume(lines);
        const combinationKey = knownCombinationKey(lines);
        const cachedContainer = findKnownCombinationContainer(combinationKey, containers, remainingContainers, knownCombinations);
        const candidateContainers = cachedContainer ? [cachedContainer] : containers;
        for (const container of candidateContainers) {
            if ((remainingContainers.get(container.sku) ?? 0) <= 0) {
                continue;
            }
            const containerVolume = volume(container.container.innerDimensions);
            if (requiredVolume > containerVolume) {
                continue;
            }
            if (!cachedContainer && packRigidItems(lines, container.container.innerDimensions) === null) {
                continue;
            }
            const candidate = {
                mask: 0,
                container,
                units: subset,
                lines,
                fillRatio: requiredVolume / containerVolume,
                dimensionalWeight: dimensionalWeight(container.container.innerDimensions),
                score: shipmentCandidateScore(lines, container.sku, container.container.innerDimensions, order, warehouseId, rateEstimator, cartonShipmentScore(container.container.innerDimensions)),
                usedKnownCombination: Boolean(cachedContainer)
            };
            if (!best || isBetterCandidate(candidate, best)) {
                best = candidate;
            }
        }
    }
    return best;
}
function optimizeExactGroupIntoShipments(group, containers, remainingContainers, orderNumber, order, warehouseId, knownCombinations, soloShippingCosts, rateEstimator, startingShipmentCount) {
    const units = expandPackingUnits(group, warehouseId);
    if (units.length > MAX_EXACT_OPTIMIZATION_UNITS) {
        return null;
    }
    const candidates = exactShipmentCandidates(units, containers, remainingContainers, knownCombinations, soloShippingCosts, rateEstimator, order, warehouseId);
    const fullMask = (1 << units.length) - 1;
    const memo = new Map();
    const solve = (mask, counts) => {
        if (mask === fullMask) {
            return [];
        }
        const memoKey = `${mask}:${[...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([sku, count]) => `${sku}:${count}`)
            .join("|")}`;
        const memoized = memo.get(memoKey);
        if (memo.has(memoKey)) {
            return memoized ? [...memoized] : null;
        }
        const firstUnpackedIndex = units.findIndex((_, index) => (mask & (1 << index)) === 0);
        let best = null;
        for (const candidate of candidates) {
            if ((candidate.mask & (1 << firstUnpackedIndex)) === 0 || (candidate.mask & mask) !== 0) {
                continue;
            }
            if (candidate.container && (counts.get(candidate.container.sku) ?? 0) <= 0) {
                continue;
            }
            const nextCounts = new Map(counts);
            if (candidate.container) {
                nextCounts.set(candidate.container.sku, (nextCounts.get(candidate.container.sku) ?? 0) - 1);
            }
            const rest = solve(mask | candidate.mask, nextCounts);
            if (!rest) {
                continue;
            }
            const plan = [candidate, ...rest];
            if (!best || isBetterShipmentPlan(plan, best)) {
                best = plan;
            }
        }
        memo.set(memoKey, best ? [...best] : null);
        return best;
    };
    const selectedCandidates = solve(0, new Map(remainingContainers));
    if (!selectedCandidates) {
        return null;
    }
    const shipments = selectedCandidates.map((candidate, index) => {
        const shipmentIndex = startingShipmentCount + index + 1;
        if (!candidate.container) {
            return singleLineShipment(orderNumber, shipmentIndex, warehouseId, candidate.lines[0], candidate.soloCostReference);
        }
        remainingContainers.set(candidate.container.sku, (remainingContainers.get(candidate.container.sku) ?? 0) - 1);
        if (!candidate.usedKnownCombination) {
            knownCombinations?.put(createKnownCombinationRecord(knownCombinationKey(candidate.lines), candidate.lines, candidate.container.sku, candidate.container.container.innerDimensions));
        }
        return {
            shipmentIndex,
            fulfillmentName: fulfillmentName(orderNumber, shipmentIndex),
            warehouseId,
            containerSku: candidate.container.sku,
            lines: candidate.lines.map(toShipmentLine),
            reasons: shipmentReasons(candidate.lines, candidate.container.sku, warehouseId, candidate.usedKnownCombination, candidate.fillRatio, candidate.dimensionalWeight)
        };
    });
    return {
        shipments,
        unpackedLines: []
    };
}
function exactShipmentCandidates(units, containers, remainingContainers, knownCombinations, soloShippingCosts, rateEstimator, order, warehouseId) {
    const candidates = [];
    const subsetCount = 2 ** units.length;
    for (let mask = 1; mask < subsetCount; mask += 1) {
        const subset = units.filter((_, index) => Boolean(mask & (1 << index)));
        const lines = unitsToOrderLines(subset);
        const requiredVolume = totalLineVolume(lines);
        if (subset.length === 1) {
            const unit = subset[0];
            const soloCostReference = soloShippingCosts?.get(unit.sku);
            candidates.push({
                mask,
                container: null,
                units: subset,
                lines,
                fillRatio: 1,
                dimensionalWeight: dimensionalWeight(unit.dimensions),
                score: shipmentCandidateScore(lines, null, undefined, order, warehouseId, rateEstimator, soloShipmentScore(unit.dimensions, soloCostReference)),
                usedKnownCombination: false,
                soloCostReference
            });
            continue;
        }
        const combinationKey = knownCombinationKey(lines);
        const cachedContainer = findKnownCombinationContainer(combinationKey, containers, remainingContainers, knownCombinations);
        const candidateContainers = cachedContainer
            ? [cachedContainer, ...containers.filter((container) => container.sku !== cachedContainer.sku)]
            : containers;
        for (const container of candidateContainers) {
            if ((remainingContainers.get(container.sku) ?? 0) <= 0) {
                continue;
            }
            const containerVolume = volume(container.container.innerDimensions);
            if (requiredVolume > containerVolume) {
                continue;
            }
            const usedKnownCombination = cachedContainer?.sku === container.sku;
            if (!usedKnownCombination && packRigidItems(lines, container.container.innerDimensions) === null) {
                continue;
            }
            const containerDimensions = container.container.innerDimensions;
            candidates.push({
                mask,
                container,
                units: subset,
                lines,
                fillRatio: requiredVolume / containerVolume,
                dimensionalWeight: dimensionalWeight(containerDimensions),
                score: shipmentCandidateScore(lines, container.sku, containerDimensions, order, warehouseId, rateEstimator, cartonShipmentScore(containerDimensions)),
                usedKnownCombination
            });
        }
    }
    return candidates.sort((a, b) => a.score - b.score || b.fillRatio - a.fillRatio || b.units.length - a.units.length);
}
function candidateUnitSubsets(units) {
    if (units.length <= MAX_EXACT_OPTIMIZATION_UNITS) {
        const subsets = [];
        const subsetCount = 2 ** units.length;
        for (let mask = 1; mask < subsetCount; mask += 1) {
            subsets.push(units.filter((_, index) => Boolean(mask & (1 << index))));
        }
        return subsets.sort((a, b) => b.length - a.length);
    }
    return greedyUnitSubsets(units);
}
function greedyUnitSubsets(units) {
    const sorted = [...units].sort((a, b) => volume(b.dimensions) - volume(a.dimensions));
    const subsets = [];
    for (let size = sorted.length; size >= 1; size -= 1) {
        subsets.push(sorted.slice(0, size));
    }
    return subsets;
}
function isBetterCandidate(candidate, best) {
    if (candidate.score !== best.score) {
        return candidate.score < best.score;
    }
    if (candidate.units.length !== best.units.length) {
        return candidate.units.length > best.units.length;
    }
    if (candidate.fillRatio !== best.fillRatio) {
        return candidate.fillRatio > best.fillRatio;
    }
    return volume(candidate.container.container.innerDimensions) < volume(best.container.container.innerDimensions);
}
function isBetterShipmentPlan(candidate, best) {
    const candidateScore = totalPlanScore(candidate);
    const bestScore = totalPlanScore(best);
    if (candidateScore !== bestScore) {
        return candidateScore < bestScore;
    }
    if (candidate.length !== best.length) {
        return candidate.length < best.length;
    }
    const candidateDimensionalWeight = totalDimensionalWeight(candidate);
    const bestDimensionalWeight = totalDimensionalWeight(best);
    if (candidateDimensionalWeight !== bestDimensionalWeight) {
        return candidateDimensionalWeight < bestDimensionalWeight;
    }
    return averageFillRatio(candidate) > averageFillRatio(best);
}
function totalPlanScore(candidates) {
    return candidates.reduce((sum, candidate) => sum + candidate.score, 0);
}
function totalDimensionalWeight(candidates) {
    return candidates.reduce((sum, candidate) => sum + candidate.dimensionalWeight, 0);
}
function averageFillRatio(candidates) {
    return candidates.reduce((sum, candidate) => sum + candidate.fillRatio, 0) / candidates.length;
}
function cartonShipmentScore(dimensions) {
    return CARTON_BASE_COST_USD + dimensionalWeight(dimensions) * CARTON_COST_PER_DIM_WEIGHT_LB_USD;
}
function soloShipmentScore(dimensions, costReference) {
    return costReference?.medianCostUsd ?? fallbackSoloShipmentScore(dimensions);
}
function fallbackSoloShipmentScore(dimensions) {
    return FALLBACK_SOLO_BASE_COST_USD + dimensionalWeight(dimensions) * FALLBACK_SOLO_COST_PER_DIM_WEIGHT_LB_USD;
}
function dimensionalWeight(dimensions) {
    const length = Math.ceil(toInches(dimensions.length, dimensions.unit));
    const width = Math.ceil(toInches(dimensions.width, dimensions.unit));
    const height = Math.ceil(toInches(dimensions.height, dimensions.unit));
    return Math.ceil((length * width * height) / DIMENSIONAL_WEIGHT_DIVISOR_IN);
}
function toInches(value, unit) {
    return unit === "in" ? value : value / 25.4;
}
function expandPackingUnits(lines, warehouseId) {
    return lines.flatMap((line) => Array.from({ length: line.quantity }, (_, index) => ({
        unitId: `${line.id}:${index}`,
        orderLineId: line.id,
        sku: line.sku,
        warehouseId,
        dimensions: requiredDimensions(line),
        packGroup: line.packGroup,
        canPackWith: line.canPackWith
    })));
}
function unitsToOrderLines(units) {
    const byLine = new Map();
    for (const unit of units) {
        const existing = byLine.get(unit.orderLineId);
        if (existing) {
            existing.quantity += 1;
            continue;
        }
        byLine.set(unit.orderLineId, {
            id: unit.orderLineId,
            sku: unit.sku,
            quantity: 1,
            dimensions: unit.dimensions,
            packGroup: unit.packGroup,
            canPackWith: unit.canPackWith
        });
    }
    return [...byLine.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function findSmallestContainer(lines, containers, remainingContainers) {
    const requiredVolume = totalLineVolume(lines);
    return (containers.find((container) => {
        if ((remainingContainers.get(container.sku) ?? 0) <= 0) {
            return false;
        }
        const inner = container.container.innerDimensions;
        const allItemsCanBePlaced = packRigidItems(lines, inner) !== null;
        return allItemsCanBePlaced && requiredVolume <= volume(inner);
    }) ?? null);
}
function shipmentReasons(group, containerSku, warehouseId, usedKnownCombination, fillRatio, dimensionalWeight) {
    const reasons = [
        `All line quantities are available in Surpath warehouse ${warehouseId}.`,
        usedKnownCombination
            ? `Known combination matched ${containerSku}, so geometry did not need to be recalculated.`
            : `Each rigid item can be placed in ${containerSku} without overlap, deformation, or protrusion.`
    ];
    if (fillRatio !== undefined) {
        const dimensionalWeightReason = dimensionalWeight === undefined ? "" : ` and ${dimensionalWeight.toFixed(0)} lb dimensional weight`;
        reasons.push(`Selected by shipping-cost proxy at ${(fillRatio * 100).toFixed(1)}% fill by volume${dimensionalWeightReason}.`);
    }
    if (group.length === 1 && group[0]?.canPackWith?.length === 0) {
        reasons.push("Line remains isolated because its packing rules do not allow consolidation.");
    }
    else {
        reasons.push("Pack-together rules allow these lines to consolidate.");
    }
    return reasons;
}
function toShipmentLine(line) {
    return {
        orderLineId: line.id,
        sku: line.sku,
        quantity: line.quantity
    };
}
function singleLineShipment(orderNumber, shipmentIndex, warehouseId, line, costReference) {
    const costReason = costReference
        ? ` Historical solo median for ${line.sku} is $${costReference.medianCostUsd.toFixed(2)} from ${costReference.shipmentCount} shipments.`
        : "";
    return {
        shipmentIndex,
        fulfillmentName: fulfillmentName(orderNumber, shipmentIndex),
        warehouseId,
        containerSku: null,
        lines: [toShipmentLine(line)],
        reasons: [`Line ships without a carton because no lower-cost qualifying carton consolidation was selected.${costReason}`]
    };
}
function fulfillmentName(orderNumber, shipmentIndex) {
    return `${orderNumber}-b${shipmentIndex}`;
}
