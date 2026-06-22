import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunWatchtowerSchedule } from "../src/watchtower/scheduler.js";

test("runs Watchtower schedule at 10:30 PM Pacific on weekdays", () => {
  assert.equal(shouldRunWatchtowerSchedule(new Date("2026-06-23T05:30:00Z"), {
    timeZone: "America/Los_Angeles",
    hour: 22,
    minute: 30,
    lastRunDateKey: null,
  }), true);
});

test("does not rerun Watchtower schedule for the same Pacific date", () => {
  assert.equal(shouldRunWatchtowerSchedule(new Date("2026-06-23T05:30:00Z"), {
    timeZone: "America/Los_Angeles",
    hour: 22,
    minute: 30,
    lastRunDateKey: "2026-06-22",
  }), false);
});

test("does not run Watchtower schedule on weekends", () => {
  assert.equal(shouldRunWatchtowerSchedule(new Date("2026-06-21T05:30:00Z"), {
    timeZone: "America/Los_Angeles",
    hour: 22,
    minute: 30,
    lastRunDateKey: null,
  }), false);
});
