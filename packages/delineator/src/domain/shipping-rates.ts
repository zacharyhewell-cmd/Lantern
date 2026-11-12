import type {
  Dimensions,
  NormalizedOrder,
  ShippingRateConfig,
  ShippingServiceLevel,
  Weight,
  WarehouseOrigin
} from "./types.js";
import { lookupFedexRate, lookupFedexZone, selectLowestPublishedRate } from "./fedex-rate-chart.js";

export const FEDEX_GROUND: ShippingServiceLevel = "FEDEX_GROUND";
export const FEDEX_EXPRESS_SAVER: ShippingServiceLevel = "FEDEX_EXPRESS_SAVER";

// Postal codes provide stable lane inputs for the comparative model. Address
// text is retained for operator reference and possible future carrier requests.
export const DEFAULT_WAREHOUSE_ORIGINS: Record<string, WarehouseOrigin> = {
  "LA-SPI1": {
    code: "LA-SPI1",
    address1: "140 N Orange Ave",
    city: "City of Industry",
    provinceCode: "CA",
    postalCode: "91744",
    countryCode: "US"
  },
  "GA-VLH1": {
    code: "GA-VLH1",
    address1: "1075 Highway 124 Building 200, Suite 200 Dock#30",
    city: "Hoschton",
    provinceCode: "GA",
    postalCode: "30548",
    countryCode: "US"
  },
  "LA-WLW2": {
    code: "LA-WLW2",
    address1: "611 Reyes Dr",
    city: "Walnut",
    provinceCode: "CA",
    postalCode: "91789",
    countryCode: "US"
  },
  "LA-HN1A": {
    code: "LA-HN1A",
    address1: "11010 Juniper Ave",
    city: "Fontana",
    provinceCode: "CA",
    postalCode: "92337",
    countryCode: "US"
  },
  "SPLALS1": {
    code: "SPLALS1",
    address1: "630 Hambledon Ave",
    city: "City of Industry",
    provinceCode: "CA",
    postalCode: "91744",
    countryCode: "US"
  },
  "NJ-RSR7": {
    code: "NJ-RSR7",
    address1: "16 Applegate Dr Unit A",
    address2: "Dock#2",
    city: "Robbinsville Twp",
    provinceCode: "NJ",
    postalCode: "08691",
    countryCode: "US"
  }
};

export const DEFAULT_FEDEX_GROUND_RATE_CONFIG: ShippingRateConfig = {
  serviceLevel: FEDEX_GROUND,
  origins: DEFAULT_WAREHOUSE_ORIGINS
};

export function resolveWarehouseOrigin(
  warehouseId: string,
  origins: Record<string, WarehouseOrigin> = DEFAULT_WAREHOUSE_ORIGINS
): WarehouseOrigin | undefined {
  const direct = origins[warehouseId];
  if (direct) return direct;
  const key = warehouseId.trim().toUpperCase();
  return Object.entries(origins).find(([code, origin]) => code.toUpperCase() === key || origin.code.toUpperCase() === key)?.[1];
}

export function createFedexGroundProxyEstimator(config: ShippingRateConfig) {
  return ({ order, lines, containerDimensions, packageDimensions, packageWeight, warehouseId }: {
    order: NormalizedOrder;
    lines: NormalizedOrder["lines"];
    containerDimensions?: Dimensions;
    packageDimensions?: Dimensions;
    packageWeight?: Weight;
    warehouseId: string;
  }): number => {
    const origin = resolveWarehouseOrigin(warehouseId, config.origins);
    const destination = order.destination;
    if (!origin || !destination?.postalCode || !destination.countryCode) {
      return Number.POSITIVE_INFINITY;
    }

    const dimensionalWeight = (containerDimensions ?? packageDimensions)
      ? dimensionalWeightFor(containerDimensions ?? packageDimensions as Dimensions)
      : 0;
    const actualWeight = packageWeight?.value ?? lines.reduce(
      (sum, line) => sum + (line.weight?.value ?? 0) * line.quantity,
      0
    );
    const billableWeight = Math.max(1, dimensionalWeight, Math.ceil(actualWeight));
    const zoneMap = config.zoneMaps?.[origin.code] ?? config.zoneMaps?.[warehouseId];
    const charts = (config.compareServiceLevels ?? [config.serviceLevel])
      .map((serviceLevel) => config.rateCharts?.[serviceLevel])
      .filter((chart): chart is NonNullable<typeof chart> => Boolean(chart));
    if (zoneMap && charts.length > 0) {
      const options = charts.flatMap((chart) => {
        const zone = lookupFedexZone(zoneMap, destination.postalCode, chart.serviceLevel);
        if (zone === undefined) return [];
        const rateUsd = lookupFedexRate(chart, billableWeight, `Zone ${zone}`);
        return rateUsd === undefined ? [] : [{ serviceLevel: chart.serviceLevel, rateUsd }];
      });
      if (options.length > 0) {
        return options.sort((a, b) => a.rateUsd - b.rateUsd)[0].rateUsd;
      }
    }
    const originPrefix = Number(origin.postalCode.slice(0, 3));
    const destinationPrefix = Number(destination.postalCode.slice(0, 3));
    const distanceProxy = Number.isFinite(originPrefix) && Number.isFinite(destinationPrefix)
      ? Math.abs(originPrefix - destinationPrefix) * 0.08
      : 25;
    const crossCountryProxy = origin.countryCode.toUpperCase() === destination.countryCode.toUpperCase() ? 0 : 50;
    const serviceProxy = config.serviceLevel === FEDEX_GROUND ? 0 : 25;
    return 10 + billableWeight * 2.95 + distanceProxy + crossCountryProxy + serviceProxy;
  };
}

function dimensionalWeightFor(dimensions: Dimensions): number {
  const length = Math.ceil(toInches(dimensions.length, dimensions.unit));
  const width = Math.ceil(toInches(dimensions.width, dimensions.unit));
  const height = Math.ceil(toInches(dimensions.height, dimensions.unit));
  return Math.ceil((length * width * height) / 139);
}

function toInches(value: number, unit: Dimensions["unit"]): number {
  return unit === "in" ? value : value / 25.4;
}
