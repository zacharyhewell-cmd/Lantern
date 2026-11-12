import {
  canFitByRotation,
  packRigidItems,
  requiredDimensions,
  totalLineVolume,
  volume
} from "../domain/geometry.js";
import { isDelineatorSku } from "../domain/reference-catalog.js";
import { normalizeInventoryItemLocation } from "../domain/surpath-adapter.js";
import { createFedexGroundProxyEstimator, resolveWarehouseOrigin } from "../domain/shipping-rates.js";
import {
  createKnownCombinationRecord,
  GEOMETRY_PROOF_VERSION,
  knownCombinationKey,
  knownCombinationProvenance,
  sameDimensions,
  sameSolution,
  type KnownCombinationRecord,
  type KnownCombinationProvenance,
  type KnownCombinationStore
} from "./known-combinations.js";
import type {
  ContainerDefinition,
  Dimensions,
  InventoryItem,
  InventorySnapshot,
  NormalizedOrder,
  OrderLine,
  ShipmentLine,
  ShipmentPlan,
  ShipmentPlanException,
  ShipmentPlanShipment,
  SoloShippingCostReference,
  ShippingAddress,
  ShippingServiceLevel,
  Weight,
  WarehouseOrigin,
  ShippingRateConfig
} from "../domain/types.js";

const MAX_EXACT_OPTIMIZATION_UNITS = 16;
const MAX_EXACT_ALLOCATION_UNITS = 12;
const MAX_ALLOCATION_CANDIDATES = 2_000;
const DIMENSIONAL_WEIGHT_DIVISOR_IN = 139;
const CARTON_BASE_COST_USD = 10;
const CARTON_COST_PER_DIM_WEIGHT_LB_USD = 2.95;
const FALLBACK_SOLO_BASE_COST_USD = 15;
const FALLBACK_SOLO_COST_PER_DIM_WEIGHT_LB_USD = CARTON_COST_PER_DIM_WEIGHT_LB_USD;

type CartonInventoryItem = InventoryItem & { container: ContainerDefinition };
type PackingUnit = {
  unitId: string;
  orderLineId: string;
  sku: string;
  dimensions: NonNullable<OrderLine["dimensions"]>;
  weight?: Weight;
  packGroup?: string;
  canPackWith?: string[];
};

type PackedShipmentCandidate = {
  mask: number;
  container: CartonInventoryItem | null;
  units: PackingUnit[];
  lines: OrderLine[];
  fillRatio: number;
  dimensionalWeight: number;
  score: number;
  usedKnownCombination: boolean;
  knownCombinationProvenance?: KnownCombinationProvenance;
  soloCostReference?: SoloShippingCostReference;
};

type OptimizedGroupResult = {
  shipments: ShipmentPlanShipment[];
  provenFits: Array<{ lines: OrderLine[]; carton: CartonInventoryItem; warehouseId: string }>;
  score: number;
};

type AllocationCandidate = Map<string, OrderLine[]>;
type AllocationOption = Array<{ warehouseId: string; line: OrderLine }>;
type StockLedger = Map<string, Map<string, number>>;

export interface ShipmentRateContext {
  order: NormalizedOrder;
  shipment: ShipmentPlanShipment;
  lines: OrderLine[];
  containerDimensions?: Dimensions;
  packageDimensions?: Dimensions;
  packageWeight?: Weight;
  destination?: ShippingAddress;
  origin?: WarehouseOrigin;
  warehouseId: string;
  serviceLevel?: ShippingServiceLevel;
  defaultProxyCost: number;
}

export type ShipmentRateEstimator = (context: ShipmentRateContext) => number;

export interface ShipmentPlannerOptions {
  knownCombinations?: KnownCombinationStore;
  soloShippingCosts?: Map<string, SoloShippingCostReference>;
  catalogSkus?: Set<string>;
  rateEstimator?: ShipmentRateEstimator;
  rateConfig?: ShippingRateConfig;
}

export function planShipments(
  order: NormalizedOrder,
  inventory: InventorySnapshot,
  options: ShipmentPlannerOptions = {}
): ShipmentPlan {
  const exceptions: ShipmentPlanException[] = [];
  const baseRateEstimator = options.rateEstimator ?? (options.rateConfig
    ? createFedexGroundProxyEstimator(options.rateConfig)
    : undefined);
  const rateEstimator: ShipmentRateEstimator | undefined = baseRateEstimator
    ? (context) => baseRateEstimator({
      ...context,
      destination: order.destination,
      origin: resolveWarehouseOrigin(context.warehouseId, options.rateConfig?.origins),
      serviceLevel: options.rateConfig?.serviceLevel ?? "FEDEX_GROUND",
      packageWeight: context.packageWeight ?? totalWeight(context.lines)
    })
    : undefined;
  const remainingStock: StockLedger = new Map();
  const cartonsByLocation = new Map<string, CartonInventoryItem>();
  for (const row of inventory.items) {
    if (!Number.isSafeInteger(row.available) || row.available <= 0) continue;
    const item = normalizeInventoryItemLocation(row, inventory.warehouseId);
    const warehouseId = item.warehouseId ?? inventory.warehouseId;
    const stock = remainingStock.get(item.sku) ?? new Map<string, number>();
    stock.set(warehouseId, (stock.get(warehouseId) ?? 0) + item.available);
    remainingStock.set(item.sku, stock);
    if (item.container) {
      const carton = { ...item, container: item.container };
      cartonsByLocation.set(containerAvailabilityKey(carton), carton);
    }
  }
  const containers = [...cartonsByLocation.values()]
    .sort((a, b) => volume(a.container.innerDimensions) - volume(b.container.innerDimensions));
  const ignoredLines = order.lines.filter((line) => !isDelineatorSku(line)).map(toShipmentLine);

  if (options.rateConfig) {
    if (!order.destination?.postalCode || !order.destination.countryCode) {
      exceptions.push({
        code: "MISSING_RATE_DATA",
        message: "Shopify did not provide a complete destination postal code and country for FedEx Ground rating.",
        orderLineIds: order.lines.map((line) => line.id)
      });
    }
  }

  const referenceLines: OrderLine[] = [];
  const linesBySku = new Map<string, OrderLine[]>();

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

    const lines = linesBySku.get(line.sku) ?? [];
    lines.push(line);
    linesBySku.set(line.sku, lines);
    referenceLines.push(line);
  }

  const eligibleSkus = new Set<string>();
  for (const [sku, lines] of linesBySku) {
    const totalAvailable = [...(remainingStock.get(sku)?.values() ?? [])].reduce((sum, available) => sum + available, 0);
    const requested = lines.reduce((sum, line) => sum + line.quantity, 0);
    const orderLineIds = lines.map((line) => line.id);
    if (totalAvailable === 0) {
      exceptions.push({
        code: "MISSING_ITEM_INVENTORY",
        message: `${sku} is not present in available Surpath inventory.`,
        orderLineIds
      });
    } else if (totalAvailable < requested) {
      exceptions.push({
        code: "INSUFFICIENT_ITEM_INVENTORY",
        message: `${sku} needs ${requested}, but Surpath only shows ${totalAvailable} available across all warehouses.`,
        orderLineIds
      });
    } else {
      eligibleSkus.add(sku);
    }
  }

  const eligibleLines = referenceLines.filter((line) => eligibleSkus.has(line.sku));
  if (options.rateConfig) {
    const warehouseIds = new Set(eligibleLines.flatMap((line) => [...(remainingStock.get(line.sku)?.keys() ?? [])]));
    for (const warehouseId of warehouseIds) {
      if (!resolveWarehouseOrigin(warehouseId, options.rateConfig.origins)) {
        exceptions.push({
          code: "MISSING_RATE_DATA",
          message: `No shipping origin address is configured for Surpath warehouse ${warehouseId}.`,
          orderLineIds: eligibleLines.map((line) => line.id)
        });
      }
    }
  }

  const shipments: ShipmentPlanShipment[] = [];

  const packableGroups = groupByPackCompatibility(eligibleLines, exceptions);

  for (const group of packableGroups) {
    const selected = selectBestAllocation(
      group,
      remainingStock,
      containers,
      order,
      options.knownCombinations,
      options.soloShippingCosts,
      rateEstimator
    );

    exceptions.push(...selected.exceptions);
    const store = options.knownCombinations;
    if (store) {
      for (const { lines, carton, warehouseId } of selected.provenFits) {
        const fit = createKnownCombinationRecord(
          knownCombinationKey(lines), lines, carton.sku, carton.container.innerDimensions,
          {
            provenance: "geometry_validated",
            geometryProofVersion: GEOMETRY_PROOF_VERSION,
            sourceOrderNumber: order.orderNumber,
            warehouseId
          }
        );
        if (!store.getAll(fit.key).some((existing) => sameSolution(existing, fit))) store.put(fit);
      }
    }
    for (const shipment of selected.shipments) {
      for (const line of shipment.lines) {
        consumeStock(remainingStock, line.sku, shipment.warehouseId, line.quantity);
      }
      if (shipment.containerSku) consumeStock(remainingStock, shipment.containerSku, shipment.warehouseId, 1);
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

function selectBestAllocation(
  group: OrderLine[],
  remainingStock: StockLedger,
  containers: CartonInventoryItem[],
  order: NormalizedOrder,
  knownCombinations: KnownCombinationStore | undefined,
  soloShippingCosts?: Map<string, SoloShippingCostReference>,
  rateEstimator?: ShipmentRateEstimator
): OptimizedGroupResult & { exceptions: ShipmentPlanException[] } {
  const candidates = enumerateAllocationCandidates(group, remainingStock, order.warehouseId);
  let best: (OptimizedGroupResult & { exceptions: ShipmentPlanException[] }) | undefined;

  for (const allocation of candidates) {
    const shipments: ShipmentPlanShipment[] = [];
    const provenFits: OptimizedGroupResult["provenFits"] = [];
    let score = 0;
    const exceptions: ShipmentPlanException[] = [];

    for (const [warehouseId, lines] of sortWarehouseEntries(allocation, order.warehouseId)) {
      const warehouseContainers = containers.filter((container) =>
        container.warehouseId === warehouseId && (remainingStock.get(container.sku)?.get(warehouseId) ?? 0) > 0
      );
      const remainingContainers = new Map(warehouseContainers.map((container) => [
        container.sku,
        remainingStock.get(container.sku)?.get(warehouseId) ?? 0
      ]));
      const unmatchedLines = lines.filter((line) =>
        !warehouseContainers.some((carton) => carton.container.innerDimensions.unit === line.dimensions?.unit)
      );
      if (warehouseContainers.length > 0 && unmatchedLines.length > 0) {
        exceptions.push({
          code: "UNIT_MISMATCH",
          message: `No cartons in ${warehouseId} use the same dimension unit as ${unmatchedLines.map((line) => line.sku).join(", ")}.`,
          orderLineIds: unmatchedLines.map((line) => line.id)
        });
      }
      const optimized = optimizeGroupIntoShipments(
        lines,
        warehouseContainers,
        remainingContainers,
        order,
        warehouseId,
        knownCombinations,
        soloShippingCosts,
        rateEstimator,
        shipments.length
      );

      shipments.push(...optimized.shipments);
      provenFits.push(...optimized.provenFits);
      score += optimized.score;
    }

    if (!best || exceptions.length < best.exceptions.length ||
        (exceptions.length === best.exceptions.length &&
          (score < best.score || (score === best.score && shipments.length < best.shipments.length)))) {
      best = { shipments, provenFits, score, exceptions };
    }
  }

  return best ?? { shipments: [], provenFits: [], score: Number.POSITIVE_INFINITY, exceptions: [{
    code: "INSUFFICIENT_ITEM_INVENTORY",
    message: "Could not allocate this group within the remaining warehouse stock.",
    orderLineIds: group.map((line) => line.id)
  }] };
}

function consumeStock(stock: StockLedger, sku: string, warehouseId: string, quantity: number): void {
  const available = stock.get(sku);
  if (available) available.set(warehouseId, (available.get(warehouseId) ?? 0) - quantity);
}

function containerAvailabilityKey(container: CartonInventoryItem): string {
  return `${container.warehouseId}:${container.sku}`;
}

function enumerateAllocationCandidates(
  group: OrderLine[],
  remainingStock: StockLedger,
  preferredWarehouseId: string
): AllocationCandidate[] {
  const unitCount = group.reduce((sum, line) => sum + line.quantity, 0);
  if (unitCount > MAX_EXACT_ALLOCATION_UNITS) {
    const candidate = greedyAllocation(group, remainingStock, preferredWarehouseId);
    return candidate ? [candidate] : [];
  }

  let candidates: AllocationCandidate[] = [new Map()];

  for (const line of group) {
    const expanded: AllocationCandidate[] = [];

    for (const candidate of candidates) {
      const available = unallocatedStock(line.sku, remainingStock, candidate);
      for (const option of enumerateLineAllocations(line, available, preferredWarehouseId)) {
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

function* enumerateLineAllocations(
  line: OrderLine,
  availability: Map<string, number>,
  preferredWarehouseId: string
): Generator<AllocationOption> {
  const warehouses = [...availability.keys()].filter((id) => (availability.get(id) ?? 0) > 0).sort((a, b) => {
    if (a === preferredWarehouseId && b !== preferredWarehouseId) return -1;
    if (b === preferredWarehouseId && a !== preferredWarehouseId) return 1;
    return a.localeCompare(b);
  });
  const suffixStock = Array<number>(warehouses.length + 1).fill(0);
  for (let i = warehouses.length - 1; i >= 0; i -= 1) {
    suffixStock[i] = suffixStock[i + 1] + (availability.get(warehouses[i]) ?? 0);
  }
  const allocations: AllocationOption = [];

  function* visit(index: number, remaining: number): Generator<AllocationOption> {
    if (remaining === 0) {
      yield [...allocations];
      return;
    }
    if (index === warehouses.length || remaining > suffixStock[index]) return;

    const warehouseId = warehouses[index];
    const minimum = Math.max(0, remaining - suffixStock[index + 1]);
    const maximum = Math.min(availability.get(warehouseId) ?? 0, remaining);
    for (let quantity = minimum; quantity <= maximum; quantity += 1) {
      if (quantity > 0) allocations.push({ warehouseId, line: { ...line, quantity } });
      yield* visit(index + 1, remaining - quantity);
      if (quantity > 0) allocations.pop();
    }
  }

  yield* visit(0, line.quantity);
}

function greedyAllocation(
  group: OrderLine[],
  remainingStock: StockLedger,
  preferredWarehouseId: string
): AllocationCandidate | undefined {
  const allocation: AllocationCandidate = new Map();
  for (const line of group) {
    const available = unallocatedStock(line.sku, remainingStock, allocation);
    const options = [...available.entries()].sort(([a, aCount], [b, bCount]) => {
      if (a === preferredWarehouseId) return -1;
      if (b === preferredWarehouseId) return 1;
      return bCount - aCount || a.localeCompare(b);
    });
    let remaining = line.quantity;
    for (const [warehouseId, count] of options) {
      if (remaining === 0) break;
      const quantity = Math.min(count, remaining);
      if (quantity <= 0) continue;
      const lines = allocation.get(warehouseId) ?? [];
      lines.push({ ...line, quantity });
      allocation.set(warehouseId, lines);
      remaining -= quantity;
    }
    if (remaining > 0) return undefined;
  }
  return allocation;
}

function unallocatedStock(sku: string, remainingStock: StockLedger, allocation: AllocationCandidate): Map<string, number> {
  const stock = new Map(remainingStock.get(sku));
  for (const [warehouseId, lines] of allocation) {
    const used = lines.reduce((total, line) => line.sku === sku ? total + line.quantity : total, 0);
    if (used > 0) stock.set(warehouseId, (stock.get(warehouseId) ?? 0) - used);
  }
  return stock;
}

function cloneAllocation(allocation: AllocationCandidate): AllocationCandidate {
  return new Map([...allocation.entries()].map(([warehouseId, lines]) => [warehouseId, [...lines]]));
}

function totalWeight(lines: OrderLine[]): Weight | undefined {
  const pounds = lines.reduce((sum, line) => sum + knownWeight(line) * line.quantity, 0);
  return pounds > 0 ? { value: pounds, unit: "lb" } : undefined;
}

function knownWeight(line: OrderLine): number {
  const weight = line.weight?.value ?? 0;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function shipmentCandidateScore(
  lines: OrderLine[],
  containerSku: string | null,
  containerDimensions: Dimensions | undefined,
  order: NormalizedOrder,
  warehouseId: string,
  rateEstimator: ShipmentRateEstimator | undefined,
  defaultProxyCost: number
): number {
  if (!rateEstimator) return defaultProxyCost;
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
    packageDimensions: containerDimensions ?? (lines.length === 1 ? requiredDimensions(lines[0] as OrderLine) : undefined),
    warehouseId,
    packageWeight: totalWeight(lines),
    defaultProxyCost
  });
}

function sortWarehouseEntries(
  lineGroups: Map<string, OrderLine[]>,
  preferredWarehouseId: string
): [string, OrderLine[]][] {
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

function findKnownCombinationContainers(
  combinationKey: string,
  containers: CartonInventoryItem[],
  remainingContainers: Map<string, number>,
  knownCombinations?: KnownCombinationStore
): Array<{ container: CartonInventoryItem; record: KnownCombinationRecord }> {
  const records = knownCombinations?.getAll(combinationKey) ?? [];
  return records.flatMap((record) => {
    const provenance = knownCombinationProvenance(record);
    const verified = provenance === "geometry_validated" && record.geometryProofVersion === GEOMETRY_PROOF_VERSION;
    const warehouseProven = isWarehouseProven(provenance);
    if (!verified && !warehouseProven) return [];
    const container = containers.find(
      (candidate) =>
        candidate.sku === record.cartonSku &&
        (warehouseProven ? Boolean(record.warehouseId) && record.warehouseId === candidate.warehouseId
          : !record.warehouseId || record.warehouseId === candidate.warehouseId) &&
        (remainingContainers.get(candidate.sku) ?? 0) > 0 &&
        sameDimensions(candidate.container.innerDimensions, record.cartonDimensions)
    );
    return container ? [{ container, record }] : [];
  });
}

function isWarehouseProven(provenance?: KnownCombinationProvenance): boolean {
  return provenance === "human_confirmed" || provenance === "historical_import";
}

function preferredKnownRecords(
  matches: Array<{ container: CartonInventoryItem; record: KnownCombinationRecord }>
): Map<string, KnownCombinationRecord> {
  const preferred = new Map<string, KnownCombinationRecord>();
  for (const match of matches) {
    const existing = preferred.get(match.container.sku);
    if (!existing ||
      (knownCombinationProvenance(existing) !== "geometry_validated" &&
        knownCombinationProvenance(match.record) === "geometry_validated")) {
      preferred.set(match.container.sku, match.record);
    }
  }
  return preferred;
}

function groupByPackCompatibility(lines: OrderLine[], exceptions: ShipmentPlanException[]): OrderLine[][] {
  const groups: OrderLine[][] = [];
  const assigned = new Set<string>();

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

    const compatible = lines.filter(
      (candidate) =>
        !assigned.has(candidate.id) &&
        candidate.id !== line.id &&
        line.canPackWith?.includes(candidate.sku) &&
        (!candidate.canPackWith || candidate.canPackWith.includes(line.sku))
    );

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

function optimizeGroupIntoShipments(
  group: OrderLine[],
  containers: CartonInventoryItem[],
  remainingContainers: Map<string, number>,
  order: NormalizedOrder,
  warehouseId: string,
  knownCombinations: KnownCombinationStore | undefined,
  soloShippingCosts: Map<string, SoloShippingCostReference> | undefined,
  rateEstimator: ShipmentRateEstimator | undefined,
  startingShipmentCount: number
): OptimizedGroupResult {
  const units = expandPackingUnits(group);
  const solo = (unit: PackingUnit, mask: number): PackedShipmentCandidate => {
    const lines = unitsToOrderLines([unit]);
    const soloCostReference = soloShippingCosts?.get(unit.sku);
    return {
      mask,
      container: null,
      units: [unit],
      lines,
      fillRatio: 1,
      dimensionalWeight: dimensionalWeight(unit.dimensions),
      score: shipmentCandidateScore(lines, null, undefined, order, warehouseId, rateEstimator, soloShipmentScore(unit.dimensions, soloCostReference)),
      usedKnownCombination: false,
      soloCostReference
    };
  };

  let selected: PackedShipmentCandidate[] | undefined;
  if (![...remainingContainers.values()].some((count) => count > 0)) {
    selected = units.map((unit) => solo(unit, 0));
  } else if (units.length <= MAX_EXACT_OPTIMIZATION_UNITS) {
    selected = optimizeExactGroupIntoShipments(units, containers, remainingContainers, order, warehouseId, knownCombinations, rateEstimator, solo);
  }

  if (!selected) {
    selected = [];
    let remainingUnits = units;
    const soloByUnit = new Map(units.map((unit) => [unit.unitId, solo(unit, 0)]));
    while (remainingUnits.length > 1 && [...remainingContainers.values()].some((count) => count > 0)) {
      let best: PackedShipmentCandidate | undefined;
      let bestSavings = -1;
      for (const subset of greedyUnitSubsets(remainingUnits)) {
        const lines = unitsToOrderLines(subset);
        const soloScore = subset.reduce((sum, unit) => sum + (soloByUnit.get(unit.unitId)?.score ?? 0), 0);
        for (const candidate of cartonCandidates(lines, subset, 0, containers, remainingContainers, knownCombinations, rateEstimator, order, warehouseId)) {
          if (candidate.score > soloScore) continue;
          const savings = candidate.score === soloScore ? 0 : soloScore - candidate.score;
          if (!best || savings > bestSavings || (savings === bestSavings && candidate.units.length > best.units.length)) {
            best = candidate;
            bestSavings = savings;
          }
        }
      }
      if (!best?.container) break;
      selected.push(best);
      remainingContainers.set(best.container.sku, (remainingContainers.get(best.container.sku) ?? 0) - 1);
      const packed = new Set(best.units.map((unit) => unit.unitId));
      remainingUnits = remainingUnits.filter((unit) => !packed.has(unit.unitId));
    }
    for (const unit of remainingUnits) {
      const candidate = soloByUnit.get(unit.unitId);
      if (candidate) selected.push(candidate);
    }
  }

  const provenFits: OptimizedGroupResult["provenFits"] = [];
  const shipments = selected.map((candidate, index) => {
    const shipmentIndex = startingShipmentCount + index + 1;
    if (!candidate.container) {
      return singleLineShipment(order.orderNumber, shipmentIndex, warehouseId, candidate.lines[0] as OrderLine, candidate.soloCostReference);
    }
    if (knownCombinations && !candidate.usedKnownCombination) {
      provenFits.push({ lines: candidate.lines, carton: candidate.container, warehouseId });
    }
    const reasons = shipmentReasons(
      candidate.lines, candidate.container.sku, warehouseId, candidate.usedKnownCombination,
      candidate.fillRatio, candidate.dimensionalWeight, candidate.knownCombinationProvenance
    );
    return {
      shipmentIndex,
      fulfillmentName: fulfillmentName(order.orderNumber, shipmentIndex),
      warehouseId,
      containerSku: candidate.container.sku,
      lines: candidate.lines.map(toShipmentLine),
      reasons
    };
  });
  return { shipments, provenFits, score: totalPlanScore(selected) };
}

function optimizeExactGroupIntoShipments(
  units: PackingUnit[],
  containers: CartonInventoryItem[],
  remainingContainers: Map<string, number>,
  order: NormalizedOrder,
  warehouseId: string,
  knownCombinations: KnownCombinationStore | undefined,
  rateEstimator: ShipmentRateEstimator | undefined,
  solo: (unit: PackingUnit, mask: number) => PackedShipmentCandidate
): PackedShipmentCandidate[] | undefined {
  const candidates: PackedShipmentCandidate[] = [];
  for (let mask = 1; mask < 2 ** units.length; mask += 1) {
    const subset = units.filter((_, index) => Boolean(mask & (1 << index)));
    if (subset.length === 1) {
      candidates.push(solo(subset[0], mask));
    } else {
      const lines = unitsToOrderLines(subset);
      candidates.push(...cartonCandidates(lines, subset, mask, containers, remainingContainers, knownCombinations, rateEstimator, order, warehouseId));
    }
  }
  candidates.sort((a, b) => a.score - b.score || b.fillRatio - a.fillRatio || b.units.length - a.units.length);
  const fullMask = (1 << units.length) - 1;
  const memo = new Map<string, PackedShipmentCandidate[] | null>();

  const solve = (mask: number, counts: Map<string, number>): PackedShipmentCandidate[] | null => {
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
    let best: PackedShipmentCandidate[] | null = null;

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

  return solve(0, new Map(remainingContainers)) ?? undefined;
}

function* cartonCandidates(
  lines: OrderLine[],
  units: PackingUnit[],
  mask: number,
  containers: CartonInventoryItem[],
  remainingContainers: Map<string, number>,
  knownCombinations: KnownCombinationStore | undefined,
  rateEstimator: ShipmentRateEstimator | undefined,
  order: NormalizedOrder,
  warehouseId: string
): Generator<PackedShipmentCandidate> {
  if (!containers.length) return;
  const requiredVolume = totalLineVolume(lines);
  const knownBySku = preferredKnownRecords(findKnownCombinationContainers(
    knownCombinationKey(lines), containers, remainingContainers, knownCombinations
  ));

  for (const container of containers) {
    const { innerDimensions } = container.container;
    const containerVolume = volume(innerDimensions);
    if ((remainingContainers.get(container.sku) ?? 0) <= 0 ||
        requiredVolume > containerVolume ||
        lines.some((line) => requiredDimensions(line).unit !== innerDimensions.unit)) {
      continue;
    }
    const known = knownBySku.get(container.sku);
    const provenance = known ? knownCombinationProvenance(known) : undefined;
    if (!isWarehouseProven(provenance) &&
        lines.some((line) => !canFitByRotation(requiredDimensions(line), innerDimensions))) {
      continue;
    }
    if (!known && !packRigidItems(lines, innerDimensions)) continue;

    yield {
      mask,
      container,
      units,
      lines,
      fillRatio: requiredVolume / containerVolume,
      dimensionalWeight: dimensionalWeight(innerDimensions),
      score: shipmentCandidateScore(
        lines, container.sku, innerDimensions, order, warehouseId, rateEstimator, cartonShipmentScore(innerDimensions)
      ),
      usedKnownCombination: Boolean(known),
      knownCombinationProvenance: provenance
    };
  }
}

function* greedyUnitSubsets(units: PackingUnit[]): Generator<PackingUnit[]> {
  const byUnit = new Map<Dimensions["unit"], PackingUnit[]>();
  for (const item of units) {
    const group = byUnit.get(item.dimensions.unit) ?? [];
    group.push(item);
    byUnit.set(item.dimensions.unit, group);
  }
  for (const group of byUnit.values()) {
    group.sort((a, b) => volume(b.dimensions) - volume(a.dimensions));
    for (let size = group.length; size >= 2; size -= 1) yield group.slice(0, size);
  }
}

function isBetterShipmentPlan(candidate: PackedShipmentCandidate[], best: PackedShipmentCandidate[]): boolean {
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

function totalPlanScore(candidates: PackedShipmentCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.score, 0);
}

function totalDimensionalWeight(candidates: PackedShipmentCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.dimensionalWeight, 0);
}

function averageFillRatio(candidates: PackedShipmentCandidate[]): number {
  return candidates.reduce((sum, candidate) => sum + candidate.fillRatio, 0) / candidates.length;
}

function cartonShipmentScore(dimensions: Dimensions): number {
  return CARTON_BASE_COST_USD + dimensionalWeight(dimensions) * CARTON_COST_PER_DIM_WEIGHT_LB_USD;
}

function soloShipmentScore(dimensions: Dimensions, costReference?: SoloShippingCostReference): number {
  return costReference?.medianCostUsd ?? fallbackSoloShipmentScore(dimensions);
}

function fallbackSoloShipmentScore(dimensions: Dimensions): number {
  return FALLBACK_SOLO_BASE_COST_USD + dimensionalWeight(dimensions) * FALLBACK_SOLO_COST_PER_DIM_WEIGHT_LB_USD;
}

function dimensionalWeight(dimensions: Dimensions): number {
  const length = Math.ceil(toInches(dimensions.length, dimensions.unit));
  const width = Math.ceil(toInches(dimensions.width, dimensions.unit));
  const height = Math.ceil(toInches(dimensions.height, dimensions.unit));

  return Math.ceil((length * width * height) / DIMENSIONAL_WEIGHT_DIVISOR_IN);
}

function toInches(value: number, unit: Dimensions["unit"]): number {
  return unit === "in" ? value : value / 25.4;
}

function expandPackingUnits(lines: OrderLine[]): PackingUnit[] {
  return lines.flatMap((line) =>
    Array.from({ length: line.quantity }, (_, index) => ({
      unitId: `${line.id}:${index}`,
      orderLineId: line.id,
      sku: line.sku,
      dimensions: requiredDimensions(line),
      weight: line.weight,
      packGroup: line.packGroup,
      canPackWith: line.canPackWith
    }))
  );
}

function unitsToOrderLines(units: PackingUnit[]): OrderLine[] {
  const byLine = new Map<string, OrderLine>();

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
      weight: unit.weight,
      packGroup: unit.packGroup,
      canPackWith: unit.canPackWith
    });
  }

  return [...byLine.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function shipmentReasons(
  group: OrderLine[],
  containerSku: string,
  warehouseId: string,
  usedKnownCombination: boolean,
  fillRatio?: number,
  dimensionalWeight?: number,
  provenance?: KnownCombinationProvenance
): string[] {
  const reasons = [
    `All line quantities are available in Surpath warehouse ${warehouseId}.`,
    usedKnownCombination && isWarehouseProven(provenance)
      ? `Warehouse-proven precedent for ${containerSku}. Diagonal or off-axis placement may be required.`
      : usedKnownCombination
        ? `Known combination matched ${containerSku}; geometry was previously validated and did not need to be recalculated.`
        : `Each rigid item can be placed in ${containerSku} without overlap, deformation, or protrusion.`
  ];

  if (fillRatio !== undefined) {
    const dimensionalWeightReason =
      dimensionalWeight === undefined ? "" : ` and ${dimensionalWeight.toFixed(0)} lb dimensional weight`;
    reasons.push(
      `Selected by shipping-cost proxy at ${(fillRatio * 100).toFixed(1)}% fill by volume${dimensionalWeightReason}.`
    );
  }

  if (group.length === 1 && group[0]?.canPackWith?.length === 0) {
    reasons.push("Line remains isolated because its packing rules do not allow consolidation.");
  } else {
    reasons.push("Pack-together rules allow these lines to consolidate.");
  }

  return reasons;
}

function toShipmentLine(line: OrderLine): ShipmentLine {
  return {
    orderLineId: line.id,
    sku: line.sku,
    quantity: line.quantity
  };
}

function singleLineShipment(
  orderNumber: string,
  shipmentIndex: number,
  warehouseId: string,
  line: OrderLine,
  costReference?: SoloShippingCostReference
): ShipmentPlanShipment {
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

function fulfillmentName(orderNumber: string, shipmentIndex: number): string {
  return `${orderNumber}-b${shipmentIndex}`;
}
