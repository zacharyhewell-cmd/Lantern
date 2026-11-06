function lookupFedexRate(chart, billableWeightLb, zone) {
  if (!Number.isFinite(billableWeightLb) || billableWeightLb < 1) return void 0;
  const row = chart.rows.find((candidate) => candidate.billableWeightLb === Math.ceil(billableWeightLb));
  return row?.ratesUsd[zone];
}
function selectLowestPublishedRate(charts, billableWeightLb, zone) {
  const options = charts.flatMap((chart) => {
    const rateUsd = lookupFedexRate(chart, billableWeightLb, zone);
    return rateUsd === void 0 ? [] : [{ serviceLevel: chart.serviceLevel, rateUsd }];
  });
  return options.sort((a, b) => a.rateUsd - b.rateUsd)[0];
}
function lookupFedexZone(zoneMap, destinationPostalCode, serviceLevel) {
  const normalized = destinationPostalCode.trim().slice(0, 5);
  if (!/^\d{5}$/.test(normalized)) return void 0;
  const zip = Number(normalized);
  const special = zoneMap.specialZones?.find((range) => zip >= Number(range.startZip) && zip <= Number(range.endZip));
  if (special) {
    const value = serviceLevel === "FEDEX_EXPRESS_SAVER" ? special.expressZone : special.groundZone;
    return value ?? void 0;
  }
  const contiguous = zoneMap.contiguousUs.find((range) => zip >= Number(range.startZip) && zip <= Number(range.endZip));
  return contiguous?.zone ?? void 0;
}
export {
  lookupFedexRate,
  lookupFedexZone,
  selectLowestPublishedRate
};
