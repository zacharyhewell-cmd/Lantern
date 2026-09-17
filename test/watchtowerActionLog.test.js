import test from "node:test";
import assert from "node:assert/strict";
import {
  actionRecordIsClosed,
  compactActionLogEntries,
  mergeActionEntries,
  mergeActionRecords,
  parseActionLog,
  parseActionLogRows,
  removeClosedActionRecords,
  serializeActionLog,
  summarizeActionsByOt,
} from "../src/watchtower/actionLog.js";

test("parses, dedupes, and summarizes action log entries by OT number", () => {
  const entries = parseActionLog([
    "OT number,Action date",
    "OT359826061600094,2026-06-20",
    "OT359826061600094,2026-06-22",
    "OT359826061600094,2026-06-22",
    "OT359826061100105,2026-06-21",
  ].join("\n"));

  const merged = mergeActionEntries(entries);
  assert.deepEqual(merged, [
    { otNumber: "OT359826061100105", actionDate: "2026-06-21" },
    { otNumber: "OT359826061600094", actionDate: "2026-06-20" },
    { otNumber: "OT359826061600094", actionDate: "2026-06-22" },
  ]);

  const summary = summarizeActionsByOt(entries);
  assert.deepEqual(summary.get("OT359826061600094"), {
    actionTaken: true,
    actionCount: 2,
    lastActionDate: "2026-06-22",
  });
});

test("serializes action logs as stable csv", () => {
  assert.equal(serializeActionLog([
    { otNumber: "ot2", actionDate: "2026-06-22" },
    { otNumber: "OT1", actionDate: "2026-06-21" },
  ]), [
    "OT number,Rule,Action count,Last action date",
    "OT1,legacy,1,2026-06-21",
    "OT2,legacy,1,2026-06-22",
    "",
  ].join("\n"));
});

test("compacts repeated actions while preserving count and last date", () => {
  const records = mergeActionRecords([
    { otNumber: "OT1", actionDate: "2026-06-20" },
    { otNumber: "OT1", actionDate: "2026-06-22" },
  ], [
    { otNumber: "OT1", rule: "preship_delay", actionDate: "2026-06-23" },
  ]);

  assert.deepEqual(records, [
    { otNumber: "OT1", rule: "preship_delay", actionCount: 3, lastActionDate: "2026-06-23" },
  ]);
  assert.deepEqual(compactActionLogEntries(parseActionLogRows([
    ["OT number", "Rule", "Action count", "Last action date"],
    ["OT1", "in_transit_delay", 4, "2026-06-22"],
  ])), [
    { otNumber: "OT1", rule: "in_transit_delay", actionCount: 4, lastActionDate: "2026-06-22" },
  ]);
});

test("closes preship actions after outbound and in-transit actions at terminal status", () => {
  const preship = {
    otNumber: "OT1",
    rule: "preship_delay",
    actionCount: 2,
    lastActionDate: "2026-06-22",
  };
  const inTransit = {
    otNumber: "OT2",
    rule: "in_transit_delay",
    actionCount: 1,
    lastActionDate: "2026-06-22",
  };
  const rows = [
    { platformCode: "OT1", actualOutboundDate: "2026-06-23", status: "Shipped - In Transit" },
    { platformCode: "OT2", deliveredDate: "2026-06-24", status: "Delivered" },
  ];

  assert.equal(actionRecordIsClosed(preship, rows), true);
  assert.equal(actionRecordIsClosed(inTransit, rows), true);
  assert.deepEqual(removeClosedActionRecords([preship, inTransit], rows), []);
});

test("does not close actions when the matching shipment is absent or still active", () => {
  assert.equal(actionRecordIsClosed({
    otNumber: "OT1",
    rule: "preship_delay",
    actionCount: 1,
    lastActionDate: "2026-06-22",
  }, []), false);
  assert.equal(actionRecordIsClosed({
    otNumber: "OT2",
    rule: "in_transit_delay",
    actionCount: 1,
    lastActionDate: "2026-06-22",
  }, [{ platformCode: "OT2", status: "In Transit" }]), false);
});
