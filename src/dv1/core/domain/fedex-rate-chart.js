/**
 * Looks up the published rate for a whole-pound billable weight and zone.
 *
 * The current source tables are published in one-pound bands. A caller must
 * round its billable weight before calling this function. We intentionally do
 * not extrapolate above the final source row because that would turn a missing
 * rate into an invented carrier price.
 */
export function lookupFedexRate(chart, billableWeightLb, zone) {
    if (!Number.isFinite(billableWeightLb) || billableWeightLb < 1)
        return undefined;
    const row = chart.rows.find((candidate) => candidate.billableWeightLb === Math.ceil(billableWeightLb));
    return row?.ratesUsd[zone];
}
/**
 * Compare the published package rates for the supplied services. This is
 * deliberately separate from ZIP-to-zone resolution so a lane table can be
 * added without changing the rate-table logic.
 */
export function selectLowestPublishedRate(charts, billableWeightLb, zone) {
    const options = charts.flatMap((chart) => {
        const rateUsd = lookupFedexRate(chart, billableWeightLb, zone);
        return rateUsd === undefined ? [] : [{ serviceLevel: chart.serviceLevel, rateUsd }];
    });
    return options.sort((a, b) => a.rateUsd - b.rateUsd)[0];
}
export function lookupFedexZone(zoneMap, destinationPostalCode, serviceLevel) {
    const normalized = destinationPostalCode.trim().slice(0, 5);
    if (!/^\d{5}$/.test(normalized))
        return undefined;
    const zip = Number(normalized);
    const special = zoneMap.specialZones?.find((range) => zip >= Number(range.startZip) && zip <= Number(range.endZip));
    if (special) {
        const value = serviceLevel === "FEDEX_EXPRESS_SAVER" ? special.expressZone : special.groundZone;
        return value ?? undefined;
    }
    const contiguous = zoneMap.contiguousUs.find((range) => zip >= Number(range.startZip) && zip <= Number(range.endZip));
    return contiguous?.zone ?? undefined;
}
