import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeActionEntries,
  parseActionLog,
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
    "OT number,Action date",
    "OT1,2026-06-21",
    "OT2,2026-06-22",
    "",
  ].join("\n"));
});
