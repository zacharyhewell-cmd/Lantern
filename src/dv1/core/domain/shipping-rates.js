export const FEDEX_GROUND = "FEDEX_GROUND";
// Postal codes are enough for the first proxy and are also the stable inputs
// expected by the eventual FedEx rating request. Address text is retained for
// operator reference and future carrier requests.
export const DEFAULT_WAREHOUSE_ORIGINS = {
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
    }
};
export const DEFAULT_FEDEX_GROUND_RATE_CONFIG = {
    serviceLevel: FEDEX_GROUND,
    origins: DEFAULT_WAREHOUSE_ORIGINS
};
export function resolveWarehouseOrigin(warehouseId, origins = DEFAULT_WAREHOUSE_ORIGINS) {
    const direct = origins[warehouseId];
    if (direct)
        return direct;
    const key = warehouseId.trim().toUpperCase();
    return Object.entries(origins).find(([code, origin]) => code.toUpperCase() === key || origin.code.toUpperCase() === key)?.[1];
}
export function createFedexGroundProxyEstimator(config) {
    return ({ order, lines, containerDimensions, packageWeight, warehouseId }) => {
        const origin = resolveWarehouseOrigin(warehouseId, config.origins);
        const destination = order.destination;
        if (!origin || !destination?.postalCode || !destination.countryCode) {
            return Number.POSITIVE_INFINITY;
        }
        const dimensionalWeight = containerDimensions
            ? Math.ceil((containerDimensions.length * containerDimensions.width * containerDimensions.height) / 139)
            : 0;
        const actualWeight = packageWeight?.value ?? lines.reduce((sum, line) => sum + (line.weight?.value ?? 0) * line.quantity, 0);
        const billableWeight = Math.max(1, dimensionalWeight, Math.ceil(actualWeight));
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
