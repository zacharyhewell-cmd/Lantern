import test from "node:test";
import assert from "node:assert/strict";
import { ltlTrackingUrl } from "../src/tracking/ltlLinks.js";

test("links recognized ABF Freight shipments to ArcBest tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "ABF Freight", trackingNumber: "150968194" }),
    "https://view.arcb.com/nlo/tools/tracking/150968194",
  );
});

test("links 4PX shipments to direct 4PX tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "4PX", trackingNumber: "4PX3002887715470CN" }),
    "https://track.4px.com/#/result/0/4PX3002887715470CN",
  );
});

test("omits LTL tracking links for unknown carriers", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Regional LTL", trackingNumber: "123" }),
    null,
  );
});

test("omits LTL tracking links for Salson Logistics because its portal requires login", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Salson Logistics", trackingNumber: "123" }),
    null,
  );
});

test("links recognized RIST Transport shipments to its tracking page", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "RIST Transport", trackingNumber: "123" }),
    "https://tracking.carrierlogistics.com/scripts/hwep.pol/facts.htm?startpage=protrace&pronum=123",
  );
});

test("links recognized Alliance Air Freight shipments to its tracking portal", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Alliance Air Freight", trackingNumber: "729560" }),
    "https://worldtrak.shipalliance.com/CVPortal/shipinquiry/ShipInfo.aspx?Back=QuickTrack&TrackType=HousebillNo&TrackNo=729560",
  );
});

test("links recognized Averitt Express shipments to direct PRO tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Averitt Express", trackingNumber: "755012" }),
    "https://tools.averitt.com/servlet/rsoLTLtrack?Type=PN&Number=755012",
  );
});

test("links recognized CrossCountry Freight Solutions shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "CrossCountry Freight Solutions", trackingNumber: "T2290848" }),
    "https://auth.ccfs.com/track/detail/T2290848",
  );
});

test("links CrossCountry Freight aliases to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "CrossCountry Freight", trackingNumber: "T2290848" }),
    "https://auth.ccfs.com/track/detail/T2290848",
  );
});

test("links recognized Lee Jennings Target Express shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Lee Jennings Target Express", trackingNumber: "274038" }),
    "https://www.ljetarget.com/trucking/SingleTracking.aspx?pn=274038",
  );
});

test("links LJETarget aliases to Lee Jennings Target Express tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "LJETarget", trackingNumber: "274038" }),
    "https://www.ljetarget.com/trucking/SingleTracking.aspx?pn=274038",
  );
});

test("links recognized TForce Freight shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "TForce Freight", trackingNumber: "96268945" }),
    "https://www.tforcefreight.com/ltl/apps/Tracking?proNumbers=96268945",
  );
});

test("links T-Force aliases to TForce Freight tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "T-Force", trackingNumber: "96268945" }),
    "https://www.tforcefreight.com/ltl/apps/Tracking?proNumbers=96268945",
  );
});

test("links recognized Priority1 shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Priority1", trackingNumber: "60114378643" }),
    "https://www.priority1.com/track-a-shipment/?BOLNumber=60114378643&submit=Go#",
  );
});

test("links Priority 1 aliases to Priority1 tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Priority 1", trackingNumber: "60114378643" }),
    "https://www.priority1.com/track-a-shipment/?BOLNumber=60114378643&submit=Go#",
  );
});

test("links recognized R+L shipments to direct PRO tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "R+L", trackingNumber: "IAD8674056" }),
    "https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=IAD8674056&docType=PRO&source=web",
  );
});

test("links RL Carriers aliases to R+L tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "RL Carriers", trackingNumber: "IAD8674056" }),
    "https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=IAD8674056&docType=PRO&source=web",
  );
});

test("links R&L Carriers aliases to R+L tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "R&L Carriers", trackingNumber: "IAD8674056" }),
    "https://www2.rlcarriers.com/freight/shipping/shipment-tracing?pro=IAD8674056&docType=PRO&source=web",
  );
});

test("links recognized Daylight shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Daylight", trackingNumber: "159856517" }),
    "https://mydaylight.dylt.com/external/shipment?probill=159856517",
  );
});

test("links DYLT aliases to Daylight tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "DYLT", trackingNumber: "159856517" }),
    "https://mydaylight.dylt.com/external/shipment?probill=159856517",
  );
});

test("links recognized Roadrunner shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Roadrunner", trackingNumber: "673722815" }),
    "https://tools.rrts.com/LTLTrack/?searchValues=673722815",
  );
});

test("links RRTS aliases to Roadrunner tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "RRTS", trackingNumber: "673722815" }),
    "https://tools.rrts.com/LTLTrack/?searchValues=673722815",
  );
});

test("links Roadrunner Freight aliases to Roadrunner tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Roadrunner Freight", trackingNumber: "673722815" }),
    "https://tools.rrts.com/LTLTrack/?searchValues=673722815",
  );
});

test("links recognized Mountain Valley Express shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Mountain Valley Express", trackingNumber: "2469885" }),
    "https://tracking.carrierlogistics.com/scripts/dcha.pol/boldetail.htm?wbtn=PRO&wpro1=2469885&seskey=&nav=&language=",
  );
});

test("links MVE aliases to Mountain Valley Express tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "MVE", trackingNumber: "2469885" }),
    "https://tracking.carrierlogistics.com/scripts/dcha.pol/boldetail.htm?wbtn=PRO&wpro1=2469885&seskey=&nav=&language=",
  );
});

test("links recognized Central Transport shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Central Transport", trackingNumber: "205141328" }),
    "https://www.centraltransport.com/tools/shipment-status?pro=205141328",
  );
});

test("links Central aliases to Central Transport tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Central", trackingNumber: "205141328" }),
    "https://www.centraltransport.com/tools/shipment-status?pro=205141328",
  );
});

test("links recognized Forward shipments to direct tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Forward", trackingNumber: "96201583" }),
    "https://www.forwardair.com/tracking?numbers=96201583",
  );
});

test("links Forward Air aliases to Forward tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Forward Air", trackingNumber: "96201583" }),
    "https://www.forwardair.com/tracking?numbers=96201583",
  );
});

test("links recognized Estes shipments to direct PRO tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Estes", trackingNumber: "0978159731" }),
    "https://www.estes-express.com/myestes/shipment-tracking/?query=0978159731&type=PRO",
  );
});

test("links Estes Express aliases to Estes tracking", () => {
  assert.equal(
    ltlTrackingUrl({ carrier: "Estes Express", trackingNumber: "0978159731" }),
    "https://www.estes-express.com/myestes/shipment-tracking/?query=0978159731&type=PRO",
  );
});
