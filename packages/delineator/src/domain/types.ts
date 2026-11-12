export type DimensionUnit = "in" | "mm";
export type WeightUnit = "lb";

import type { FedexRateChart, FedexZoneMap } from "./fedex-rate-chart.js";

export interface Dimensions {
  length: number;
  width: number;
  height: number;
  unit: DimensionUnit;
}

export interface Weight {
  value: number;
  unit: WeightUnit;
}

export interface ShippingAddress {
  name?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  provinceCode?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
}

export interface WarehouseOrigin {
  code: string;
  address1: string;
  address2?: string;
  city: string;
  provinceCode: string;
  postalCode: string;
  countryCode: string;
}

export type ShippingServiceLevel = "FEDEX_GROUND" | "FEDEX_EXPRESS_SAVER";

export interface ShippingRateConfig {
  serviceLevel: ShippingServiceLevel;
  origins: Record<string, WarehouseOrigin>;
  rateCharts?: Partial<Record<ShippingServiceLevel, FedexRateChart>>;
  zoneMaps?: Record<string, FedexZoneMap>;
  compareServiceLevels?: ShippingServiceLevel[];
}

export interface OrderLine {
  id: string;
  sku: string;
  quantity: number;
  dimensions?: Dimensions;
  weight?: Weight;
  packGroup?: string;
  canPackWith?: string[];
}

export interface NormalizedOrder {
  orderId: string;
  orderNumber: string;
  warehouseId: string;
  lines: OrderLine[];
  destination?: ShippingAddress;
}

export interface ContainerDefinition {
  innerDimensions: Dimensions;
  /** @deprecated Legacy metadata. Carton fit uses geometry. */
  maxWeight?: Weight;
}

export interface InventoryItem {
  sku: string;
  available: number;
  warehouseId?: string;
  container?: ContainerDefinition;
}

export interface InventorySnapshot {
  warehouseId: string;
  items: InventoryItem[];
}

export interface ShipmentLine {
  orderLineId: string;
  sku: string;
  quantity: number;
}

export interface ShipmentPlanShipment {
  shipmentIndex: number;
  fulfillmentName: string;
  warehouseId: string;
  containerSku: string | null;
  lines: ShipmentLine[];
  reasons: string[];
}

export interface ShipmentPlanException {
  code:
    | "MISSING_ITEM_INVENTORY"
    | "INSUFFICIENT_ITEM_INVENTORY"
    | "MISSING_REFERENCE_DATA"
    | "UNIT_MISMATCH"
    | "NO_CONTAINER_AVAILABLE"
    | "PACKING_RULE_BLOCKED"
    | "MISSING_RATE_DATA";
  message: string;
  orderLineIds: string[];
}

export interface ShipmentPlan {
  orderId: string;
  orderNumber: string;
  warehouseId: string;
  status: "ready" | "needs_review";
  shipments: ShipmentPlanShipment[];
  exceptions: ShipmentPlanException[];
  ignoredLines: ShipmentLine[];
}

export interface SoloShippingCostReference {
  sku: string;
  shipmentCount: number;
  averageCostUsd: number;
  medianCostUsd: number;
  p75CostUsd?: number;
  p90CostUsd?: number;
  minCostUsd?: number;
  maxCostUsd?: number;
  sourceNote?: string;
}

export interface SoloShippingCostCatalog {
  currency: "USD";
  generatedFrom?: {
    spreadsheetToken?: string;
    sheetId?: string;
    scannedRows?: number;
    aaRows?: number;
    generatedAt?: string;
  };
  costs: SoloShippingCostReference[];
}

export interface SkuReference {
  sku: string;
  name?: string;
  dimensions: Dimensions;
  weight?: Weight;
  packGroup?: string;
  canPackWith?: string[];
  sourceNote?: string;
}

export interface CartonReference {
  sku: string;
  name: string;
  innerDimensions: Dimensions;
  /** @deprecated Legacy metadata. Carton fit uses geometry. */
  maxWeight?: Weight;
  sourceNote?: string;
}

export interface ReferenceCatalog {
  generatedFrom?: {
    sourceType?: string;
    sourceTitle?: string;
    wikiUrl?: string;
    spreadsheetToken?: string;
    sheetId?: string;
    revision?: number;
    sourceColumns?: string[];
    excludedColumns?: string[];
    fetchedAt?: string;
    sourceRowCount?: number;
    includedSourceRows?: number;
    skippedSourceRows?: number;
  };
  skus: SkuReference[];
  cartons: CartonReference[];
}
