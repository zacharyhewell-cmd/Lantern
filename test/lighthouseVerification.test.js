import test from "node:test";
import assert from "node:assert/strict";
import { matchesShippingPostalCode } from "../src/lighthouse/verification.js";

function summary(postalCode) {
  return { verification: { shippingPostalCode: postalCode } };
}

test("verifies shipping postal codes without exposing formatting differences", () => {
  assert.equal(matchesShippingPostalCode(summary("97214"), "97214"), true);
  assert.equal(matchesShippingPostalCode(summary("97214-1234"), "97214"), true);
  assert.equal(matchesShippingPostalCode(summary("SW1A 1AA"), "sw1a-1aa"), true);
  assert.equal(matchesShippingPostalCode(summary("97214"), "97215"), false);
  assert.equal(matchesShippingPostalCode(summary(null), "97214"), false);
  assert.equal(matchesShippingPostalCode(summary("97214"), ""), false);
});
