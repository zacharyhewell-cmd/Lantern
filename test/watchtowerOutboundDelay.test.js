import test from "node:test";
import assert from "node:assert/strict";
import {
  findOutboundDelayFindings,
  groupWatchtowerFindings,
} from "../src/watchtower/outboundDelay.js";
import { formatWatchtowerOutboundDelayReport } from "../src/formatters/watchtowerReport.js";

function row(overrides = {}) {
  return {
    id: Math.random(),
    customerPlatformCode: "WS-#33000",
    expressNumber: "873097980414",
    wmsOutboundCode: "A001-260616-0033",
    expressFromCode: "US_FEDEX_GROUND",
    status: "待出库",
    createTime: Date.UTC(2026, 5, 1, 12),
    actualOutboundDate: Date.UTC(2026, 5, 5, 0),
    sku: "SKU-1",
    quantity: 1,
    ...overrides,
  };
}

test("finds WS shipment groups where outbound delay exceeds threshold", () => {
  const findings = findOutboundDelayFindings([
    row({ sku: "SKU-1", quantity: 1 }),
    row({ sku: "SKU-2", quantity: 2 }),
  ], { thresholdHours: 72 });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].orderNumber, "WS-#33000");
  assert.equal(findings[0].shipmentCode, "873097980414");
  assert.equal(findings[0].carrierGroup, "fedex");
  assert.equal(findings[0].elapsedHours, 84);
  assert.deepEqual(findings[0].items, [
    { sku: "SKU-1", quantity: 1 },
    { sku: "SKU-2", quantity: 2 },
  ]);
});

test("excludes delivered rows and rows without WS order numbers", () => {
  const findings = findOutboundDelayFindings([
    row({ customerPlatformCode: "SO-33000" }),
    row({ deliveredDate: Date.UTC(2026, 5, 5, 1), status: "已妥投" }),
  ], { thresholdHours: 72 });

  assert.deepEqual(findings, []);
});

test("sorts findings by highest lateness first and groups by carrier type", () => {
  const findings = findOutboundDelayFindings([
    row({
      customerPlatformCode: "WS-#33001",
      expressNumber: "873097980414",
      createTime: Date.UTC(2026, 5, 1, 12),
      actualOutboundDate: Date.UTC(2026, 5, 5, 0),
    }),
    row({
      customerPlatformCode: "WS-#33002",
      expressNumber: "LTL-1",
      carrierName: "CrossCountry Freight",
      expressFromCode: "",
      createTime: Date.UTC(2026, 5, 1, 12),
      actualOutboundDate: Date.UTC(2026, 5, 6, 12),
    }),
  ], { thresholdHours: 72 });

  assert.equal(findings[0].orderNumber, "WS-#33002");
  assert.equal(findings[0].carrierGroup, "ltl");
  assert.equal(findings[1].carrierGroup, "fedex");

  const grouped = groupWatchtowerFindings(findings);
  assert.equal(grouped.fedex[0].orderNumber, "WS-#33001");
  assert.equal(grouped.ltl[0].orderNumber, "WS-#33002");
});

test("formats FedEx and LTL outbound delay sections", () => {
  const findings = findOutboundDelayFindings([
    row({
      customerPlatformCode: "WS-#33001",
      expressNumber: "873097980414",
      createTime: Date.UTC(2026, 5, 1, 12),
      actualOutboundDate: Date.UTC(2026, 5, 5, 0),
    }),
    row({
      customerPlatformCode: "WS-#33002",
      expressNumber: "LTL-1",
      carrierName: "CrossCountry Freight",
      expressFromCode: "",
      createTime: Date.UTC(2026, 5, 1, 12),
      actualOutboundDate: Date.UTC(2026, 5, 6, 12),
    }),
  ], { thresholdHours: 72 });

  const report = formatWatchtowerOutboundDelayReport(findings, { thresholdHours: 72 });

  assert.match(report, /Watchtower: outbound delay > 72h/);
  assert.match(report, /FedEx\n\nWS-#33001 - worst delay 84\.0h/);
  assert.match(report, /LTL \/ other carriers\n\nWS-#33002 - worst delay 120\.0h/);
  assert.match(report, /Shipment: LTL-1/);
});
