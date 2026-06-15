import test from "node:test";
import assert from "node:assert/strict";
import { detectCarrier } from "../src/tracking/carriers.js";

test("uses FedEx URL to replace vague Shopify carrier", () => {
  assert.equal(detectCarrier({
    company: "other",
    trackingNumber: "872031354189",
    trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=872031354189",
  }), "FedEx");
});

test("uses FedEx numeric pattern when carrier is vague", () => {
  assert.equal(detectCarrier({
    company: "other",
    trackingNumber: "872031354189",
    trackingUrl: "",
  }), "FedEx");
});

test("uses FedEx numeric pattern when Surpath carrier code is internal", () => {
  assert.equal(detectCarrier({
    company: "797857",
    trackingNumber: "380342780636",
    trackingUrl: "",
  }), "FedEx");
});

test("recognizes Surpath FedEx channel codes", () => {
  assert.equal(detectCarrier({
    company: "YMKGMD_FED",
    trackingNumber: "885695295600",
    trackingUrl: "",
  }), "FedEx");
});

test("recognizes 4PX tracking numbers before USPS last-mile patterns", () => {
  assert.equal(detectCarrier({
    company: "other",
    trackingNumber: "4PX3002887715470CN",
    trackingUrl: "",
  }), "4PX");
});

test("recognizes 4PX tracking URLs", () => {
  assert.equal(detectCarrier({
    company: "other",
    trackingNumber: "4PX3002887715470CN",
    trackingUrl: "https://track.4px.com/#/result/0/4PX3002887715470CN",
  }), "4PX");
});

test("uses 4PX tracking number over USPS company and URL", () => {
  assert.equal(detectCarrier({
    company: "USPS",
    trackingNumber: "4PX3002887715470CN",
    trackingUrl: "https://tools.usps.com/go/TrackConfirmAction?tLabels=4PX3002887715470CN",
  }), "4PX");
});

test("preserves TForce Freight when Surpath includes old UPS Freight wording", () => {
  assert.equal(detectCarrier({
    company: "TForce Freight (UPS Freight)",
    trackingNumber: "554369222",
    trackingUrl: "",
  }), "TForce Freight");
});

test("preserves specific known carrier from Shopify", () => {
  assert.equal(detectCarrier({
    company: "UPS",
    trackingNumber: "872031354189",
    trackingUrl: "https://example.com/track",
  }), "UPS");
});

test("does not invent a carrier for ambiguous non-vague Shopify values", () => {
  assert.equal(detectCarrier({
    company: "Regional Carrier",
    trackingNumber: "872031354189",
    trackingUrl: "",
  }), "Regional Carrier");
});
