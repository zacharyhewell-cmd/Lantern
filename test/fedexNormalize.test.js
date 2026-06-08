import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFedExTracking } from "../src/fedex/normalize.js";

test("normalizes FedEx tracking response latest event", () => {
  const summary = normalizeFedExTracking({
    output: {
      completeTrackResults: [{
        trackResults: [{
          trackingNumberInfo: { trackingNumber: "872031354189" },
          latestStatusDetail: { description: "On the way" },
          estimatedDeliveryTimeWindow: {
            window: { ends: "2026-05-26T20:00:00-07:00" },
          },
          scanEvents: [{
            eventDescription: "Departed FedEx location",
            date: "2026-05-20T10:00:00-07:00",
            scanLocation: {
              city: "Bloomington",
              stateOrProvinceCode: "CA",
              countryCode: "US",
            },
          }],
        }],
      }],
    },
  });

  assert.equal(summary.carrier, "FedEx");
  assert.equal(summary.status, "On the way");
  assert.equal(summary.latestEvent.description, "Departed FedEx location");
  assert.equal(summary.latestEvent.location, "Bloomington, CA, US");
});
