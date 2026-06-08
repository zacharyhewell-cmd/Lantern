import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSurpathShipmentStatus, normalizeSurpathStatus } from "../src/surpath/status.js";

test("maps Surpath English statuses to Lantern statuses", () => {
  assert.equal(normalizeSurpathStatus("Pending"), "Unfulfilled");
  assert.equal(normalizeSurpathStatus("Shipped - Not Pickup"), "Waiting for pickup");
  assert.equal(normalizeSurpathStatus("Shipped - In Transit"), "In Transit");
});

test("maps known Surpath delivered and Chinese pending statuses", () => {
  assert.equal(normalizeSurpathStatus("已妥投"), "Delivered");
  assert.equal(normalizeSurpathStatus("待出库"), "Unfulfilled");
  assert.equal(normalizeSurpathStatus("派送中"), "In Transit");
});

test("guesses common LTL carrier status language", () => {
  assert.equal(normalizeSurpathStatus("Pickup Scheduled"), "Waiting for pickup");
  assert.equal(normalizeSurpathStatus("Arrived at destination terminal"), "In Transit");
  assert.equal(normalizeSurpathStatus("Out for Delivery"), "In Transit");
  assert.equal(normalizeSurpathStatus("Delivery Completed"), "Delivered");
});

test("maps LTL pre-carrier unfulfilled state to LTL processing", () => {
  assert.equal(
    normalizeSurpathShipmentStatus({ status: "待出库", carrier: "LTL" }),
    "Fulfilled - LtL processing",
  );
});
