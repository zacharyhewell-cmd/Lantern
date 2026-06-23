import test from "node:test";
import assert from "node:assert/strict";
import { buildWatchtowerSheetReport } from "../src/watchtower/spreadsheetReport.js";

test("Watchtower in-transit headers make day units explicit", () => {
  const report = buildWatchtowerSheetReport([]);
  const inTransitSheets = report.sheets.filter((sheet) => sheet.name.startsWith("In Transit"));

  assert.equal(inTransitSheets.length, 2);
  for (const sheet of inTransitSheets) {
    assert.equal(sheet.headers[6], "In Transit Days");
    assert.equal(sheet.headers[7], "Stale Days");
  }
});
