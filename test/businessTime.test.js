import test from "node:test";
import assert from "node:assert/strict";
import { businessHoursBetween, businessTimeZoneForWarehouse } from "../src/watchtower/businessTime.js";

test("counts only Monday-Friday business hours", () => {
  const start = Date.UTC(2026, 5, 19, 22, 0); // Fri 3 PM Pacific
  const end = Date.UTC(2026, 5, 22, 18, 0); // Mon 11 AM Pacific

  assert.equal(businessHoursBetween(start, end, {
    timeZone: "America/Los_Angeles",
    startHour: 9,
    endHour: 17,
  }), 4);
});

test("counts business hours in the selected timezone", () => {
  const start = Date.UTC(2026, 5, 22, 13, 0); // Mon 9 AM Eastern, 6 AM Pacific
  const end = Date.UTC(2026, 5, 22, 15, 0); // Mon 11 AM Eastern, 8 AM Pacific

  assert.equal(businessHoursBetween(start, end, {
    timeZone: "America/New_York",
    startHour: 9,
    endHour: 17,
  }), 2);
  assert.equal(businessHoursBetween(start, end, {
    timeZone: "America/Los_Angeles",
    startHour: 9,
    endHour: 17,
  }), 0);
});

test("maps known Watchtower warehouses to business timezones", () => {
  assert.equal(businessTimeZoneForWarehouse("GA-VLH1"), "America/New_York");
  assert.equal(businessTimeZoneForWarehouse("NJ-RSR7"), "America/New_York");
  assert.equal(businessTimeZoneForWarehouse("LA-SPI1"), "America/Los_Angeles");
  assert.equal(businessTimeZoneForWarehouse("SPLALS1"), "America/Los_Angeles");
  assert.equal(businessTimeZoneForWarehouse("TX-LST5"), "America/Chicago");
});
