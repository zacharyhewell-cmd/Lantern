import test from "node:test";
import assert from "node:assert/strict";
import { enrichSummaryWithFedEx } from "../src/fedex/enrich.js";
import { formatTrackingReply } from "../src/formatters/trackingReply.js";

test("maps FedEx shipment information sent to waiting for pickup", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return Response.json({ access_token: "token" });
    }

    return Response.json({
      output: {
        completeTrackResults: [{
          trackResults: [{
            trackingNumberInfo: { trackingNumber: "872031354189" },
            latestStatusDetail: { description: "Shipment information sent to FedEx" },
            scanEvents: [{
              eventDescription: "Shipment information sent to FedEx",
              scanLocation: { countryCode: "US" },
            }],
          }],
        }],
      },
    });
  };

  const summary = await enrichSummaryWithFedEx({
    shipments: [{
      status: "In Transit",
      tracking: [{
        carrier: "FedEx",
        trackingNumber: "872031354189",
      }],
    }],
  }, {
    clientId: "client",
    clientSecret: "secret",
    apiBaseUrl: "https://apis.fedex.com",
  }, fetchImpl);

  assert.equal(summary.shipments[0].status, "Waiting for pickup");
});

test("overrides copied Shopify delivered timestamp when FedEx is not delivered", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return Response.json({ access_token: "token" });
    }

    return Response.json({
      output: {
        completeTrackResults: [{
          trackResults: [{
            trackingNumberInfo: { trackingNumber: "871988299145" },
            latestStatusDetail: { description: "Arrived at FedEx location" },
            scanEvents: [{
              eventDescription: "Arrived at FedEx location",
              scanLocation: { city: "WALNUT", stateOrProvinceCode: "CA", countryCode: "US" },
            }],
          }],
        }],
      },
    });
  };

  const summary = await enrichSummaryWithFedEx({
    shipments: [{
      status: "Delivered",
      deliveredAt: "2026-05-20T14:14:00Z",
      tracking: [{
        carrier: "FedEx",
        trackingNumber: "871988299145",
      }],
    }],
  }, {
    clientId: "client",
    clientSecret: "secret",
    apiBaseUrl: "https://apis.fedex.com",
  }, fetchImpl);

  assert.equal(summary.shipments[0].status, "In Transit");
  assert.equal(summary.shipments[0].deliveredAt, null);
});

test("uses FedEx delivered status and scan time over upstream shipment state", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/oauth/token")) {
      return Response.json({ access_token: "token" });
    }

    return Response.json({
      output: {
        completeTrackResults: [{
          trackResults: [{
            trackingNumberInfo: { trackingNumber: "872018666470" },
            latestStatusDetail: { description: "Delivered" },
            scanEvents: [{
              eventDescription: "Delivered",
              date: "2026-05-27T13:57:46-04:00",
              scanLocation: { city: "Absecon", stateOrProvinceCode: "NJ", countryCode: "US" },
            }],
          }],
        }],
      },
    });
  };

  const summary = await enrichSummaryWithFedEx({
    shipments: [{
      status: "In Transit",
      deliveredAt: null,
      items: [],
      tracking: [{
        carrier: "FedEx",
        trackingNumber: "872018666470",
      }],
    }],
  }, {
    clientId: "client",
    clientSecret: "secret",
    apiBaseUrl: "https://apis.fedex.com",
  }, fetchImpl);

  assert.equal(summary.shipments[0].status, "Delivered");
  assert.equal(summary.shipments[0].deliveredAt, "2026-05-27T13:57:46-04:00");
  assert.match(formatTrackingReply({
    found: true,
    orderName: "WS-#12345",
    shipments: summary.shipments,
    unfulfilledItems: [],
    warnings: [],
  }), /Latest update: Delivered, Absecon, NJ, US, May 27, 2026, 10:57 AM/);
});
