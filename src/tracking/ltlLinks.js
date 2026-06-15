function includesAny(value, needles) {
  const normalized = String(value || "").toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

export function ltlTrackingUrl({ carrier, trackingNumber }) {
  if (includesAny(carrier, ["4px", "4 px"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://track.4px.com/#/result/0/${number}`;
  }

  if (includesAny(carrier, ["abf", "arcbest"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://view.arcb.com/nlo/tools/tracking/${number}`;
  }

  if (includesAny(carrier, ["rist transport", "rist"])) {
    const query = trackingNumber ? `?startpage=protrace&pronum=${encodeURIComponent(trackingNumber)}` : "";
    return `https://tracking.carrierlogistics.com/scripts/hwep.pol/facts.htm${query}`;
  }

  if (includesAny(carrier, ["alliance air freight", "shipalliance"])) {
    const query = trackingNumber
      ? `?Back=QuickTrack&TrackType=HousebillNo&TrackNo=${encodeURIComponent(trackingNumber)}`
      : "";
    return `https://worldtrak.shipalliance.com/CVPortal/shipinquiry/ShipInfo.aspx${query}`;
  }

  if (includesAny(carrier, ["averitt express", "averitt"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://tools.averitt.com/servlet/rsoLTLtrack?Type=PN&Number=${number}`;
  }

  if (includesAny(carrier, ["crosscountry freight solutions", "cross country freight", "ccfs"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://auth.ccfs.com/track/detail/${number}`;
  }

  if (includesAny(carrier, ["lee jennings target express", "ljetarget", "lje target"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.ljetarget.com/trucking/SingleTracking.aspx?pn=${number}`;
  }

  if (includesAny(carrier, ["tforce freight", "t-force freight", "tforce", "t-force"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.tforcefreight.com/ltl/apps/Tracking?proNumbers=${number}`;
  }

  if (includesAny(carrier, ["priority1", "priority 1"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.priority1.com/track-a-shipment/?BOLNumber=${number}&submit=Go#`;
  }

  if (includesAny(carrier, ["r+l", "rl carriers", "r l carriers", "r&l", "r and l"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=${number}&docType=PRO&source=web`;
  }

  if (includesAny(carrier, ["daylight", "dylt"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://mydaylight.dylt.com/external/shipment?probill=${number}`;
  }

  if (includesAny(carrier, ["roadrunner", "rrts"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://tools.rrts.com/LTLTrack/?searchValues=${number}`;
  }

  if (includesAny(carrier, ["mountain valley express", "mve"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://tracking.carrierlogistics.com/scripts/dcha.pol/boldetail.htm?wbtn=PRO&wpro1=${number}&seskey=&nav=&language=`;
  }

  if (includesAny(carrier, ["central transport", "central"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.centraltransport.com/tools/shipment-status?pro=${number}`;
  }

  if (includesAny(carrier, ["forward air", "forward"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.forwardair.com/tracking?numbers=${number}`;
  }

  if (includesAny(carrier, ["estes express", "estes"])) {
    const number = trackingNumber ? encodeURIComponent(trackingNumber) : "";
    return `https://www.estes-express.com/myestes/shipment-tracking/?query=${number}&type=PRO`;
  }

  return null;
}
