import {
  mergeActionEntries,
  serializeActionLog,
  summarizeActionsByOt,
} from "./actionLog.js";
import {
  buildWatchtowerSheetReport,
  STALE_THRESHOLD_DAYS,
  WATCHTOWER_SHEETS,
} from "./spreadsheetReport.js";

const ACTION_LOG_SHEET = "_Watchtower Actions";
const MAX_VISIBLE_ROWS = 2000;
const MAX_ACTION_LOG_ROWS = 20000;

function isChecked(value) {
  if (value === true) {
    return true;
  }

  const text = String(value || "").trim().toLowerCase();
  return ["true", "yes", "y", "1", "checked", "x"].includes(text);
}

function colName(index) {
  let value = "";
  let current = index + 1;
  while (current > 0) {
    const mod = (current - 1) % 26;
    value = String.fromCharCode(65 + mod) + value;
    current = Math.floor((current - mod) / 26);
  }
  return value;
}

function sheetList(spreadsheetInfo) {
  const spreadsheet = spreadsheetInfo?.data?.spreadsheet || spreadsheetInfo?.spreadsheet || spreadsheetInfo?.data || {};
  return spreadsheet.sheets || spreadsheet.properties?.sheets || [];
}

function normalizeSheet(sheet) {
  const properties = sheet.properties || sheet;
  return {
    id: properties.sheet_id || properties.sheetId || properties.id,
    title: properties.title,
  };
}

function parseValues(result) {
  return result?.data?.valueRange?.values ||
    result?.data?.value_range?.values ||
    result?.valueRange?.values ||
    [];
}

function actionEntriesFromValues(values, actionDate) {
  if (!values?.length) {
    return [];
  }

  const headers = values[0].map((value) => String(value || "").trim());
  const otIndex = headers.indexOf("OT number");
  const actionIndex = headers.indexOf("Action taken?");
  if (otIndex < 0 || actionIndex < 0) {
    return [];
  }

  return values.slice(1)
    .filter((row) => isChecked(row[actionIndex]))
    .map((row) => ({ otNumber: row[otIndex], actionDate }));
}

function actionLogEntriesFromValues(values) {
  if (!values?.length) {
    return [];
  }

  return mergeActionEntries(values.slice(1).map((row) => ({
    otNumber: row[0],
    actionDate: row[1],
  })));
}

function booleanForSheet(value) {
  return value === true ? "TRUE" : value === false ? "FALSE" : value;
}

function matrixForSheet(headers, rows, minimumRows = 1) {
  const matrix = [
    headers,
    ...rows.map((row) => row.map(booleanForSheet)),
  ];
  while (matrix.length < minimumRows) {
    matrix.push(headers.map(() => ""));
  }
  return matrix;
}

async function readRangeOrEmpty(client, spreadsheetToken, range) {
  try {
    return parseValues(await client.readSheetRange(spreadsheetToken, range));
  } catch {
    return [];
  }
}

async function getSheetsByTitle(client, spreadsheetToken) {
  const info = await client.getSpreadsheet(spreadsheetToken);
  return new Map(sheetList(info).map(normalizeSheet).filter((sheet) => sheet.id && sheet.title).map((sheet) => [sheet.title, sheet]));
}

async function ensureSheets(client, spreadsheetToken) {
  let sheetsByTitle = await getSheetsByTitle(client, spreadsheetToken);
  const requiredTitles = [...WATCHTOWER_SHEETS, ACTION_LOG_SHEET];
  const requests = [];
  const existingSheets = [...sheetsByTitle.values()];
  const unnamedFirstSheet = existingSheets.length === 1 && !requiredTitles.includes(existingSheets[0].title)
    ? existingSheets[0]
    : null;

  for (const title of requiredTitles) {
    if (sheetsByTitle.has(title)) {
      continue;
    }

    if (unnamedFirstSheet && !requests.length) {
      requests.push({
        updateSheet: {
          properties: {
            sheetId: unnamedFirstSheet.id,
            title,
            frozenRowCount: 1,
            hidden: title === ACTION_LOG_SHEET,
          },
        },
      });
    } else {
      requests.push({
        addSheet: {
          properties: {
            title,
            hidden: title === ACTION_LOG_SHEET,
          },
        },
      });
    }
  }

  if (requests.length) {
    await client.batchUpdateSheets(spreadsheetToken, requests);
    sheetsByTitle = await getSheetsByTitle(client, spreadsheetToken);
  }

  const freezeAndHideRequests = requiredTitles
    .map((title) => sheetsByTitle.get(title))
    .filter(Boolean)
    .map((sheet) => ({
      updateSheet: {
        properties: {
          sheetId: sheet.id,
          frozenRowCount: 1,
          hidden: sheet.title === ACTION_LOG_SHEET,
        },
      },
    }));
  if (freezeAndHideRequests.length) {
    await client.batchUpdateSheets(spreadsheetToken, freezeAndHideRequests);
  }

  return getSheetsByTitle(client, spreadsheetToken);
}

async function checkedActionsFromLiveSheets(client, spreadsheetToken, sheetsByTitle, reportDate) {
  const entries = [];
  for (const title of WATCHTOWER_SHEETS) {
    const sheet = sheetsByTitle.get(title);
    if (!sheet) {
      continue;
    }

    const values = await readRangeOrEmpty(client, spreadsheetToken, `${sheet.id}!A1:M${MAX_VISIBLE_ROWS}`);
    entries.push(...actionEntriesFromValues(values, reportDate));
  }

  return entries;
}

async function actionLogFromSheet(client, spreadsheetToken, actionLogSheet) {
  if (!actionLogSheet) {
    return [];
  }

  const values = await readRangeOrEmpty(client, spreadsheetToken, `${actionLogSheet.id}!A1:B${MAX_ACTION_LOG_ROWS}`);
  return actionLogEntriesFromValues(values);
}

async function writeActionLogSheet(client, spreadsheetToken, actionLogSheet, actionEntries) {
  const rows = [
    ["OT number", "Action date"],
    ...mergeActionEntries(actionEntries).map((entry) => [entry.otNumber, entry.actionDate]),
  ];
  await client.writeSheetRange(spreadsheetToken, `${actionLogSheet.id}!A1:B${Math.max(rows.length, 2)}`, rows);
}

function duplicateRuns(rows) {
  const runs = [];
  let start = 0;
  let current = rows[0]?.[0];
  for (let index = 1; index <= rows.length; index += 1) {
    const next = rows[index]?.[0];
    if (next !== current) {
      if (index - start > 1 && current) {
        runs.push({ start, end: index - 1 });
      }
      start = index;
      current = next;
    }
  }
  return runs;
}

async function styleVisibleSheet(client, spreadsheetToken, sheet, definition, rowCount) {
  const lastCol = colName(definition.headers.length - 1);
  await client.setSheetStyle(spreadsheetToken, `${sheet.id}!A1:${lastCol}1`, {
    backColor: "#1F4E78",
    font: { bold: true },
    textDecoration: 0,
    foreColor: "#FFFFFF",
  });
  await client.setSheetStyle(spreadsheetToken, `${sheet.id}!A2:${lastCol}${Math.max(rowCount, 2)}`, {
    backColor: "#FFFFFF",
  });

  const checkboxColumnIndex = definition.options.checkboxColumnIndex;
  if (checkboxColumnIndex != null) {
    const col = colName(checkboxColumnIndex);
    await client.setSheetDropdown(spreadsheetToken, `${sheet.id}!${col}2:${col}${MAX_VISIBLE_ROWS}`, ["TRUE", "FALSE"]);
  }

  const duplicateColors = ["#FFF2CC", "#DDEBF7"];
  for (const [index, run] of duplicateRuns(definition.rows).entries()) {
    await client.setSheetStyle(spreadsheetToken, `${sheet.id}!A${run.start + 2}:A${run.end + 2}`, {
      backColor: duplicateColors[index % duplicateColors.length],
    });
  }

  const staleColumnIndex = definition.options.staleColumnIndex;
  if (staleColumnIndex != null) {
    const col = colName(staleColumnIndex);
    for (const [index, row] of definition.rows.entries()) {
      const staleDays = Number(row[staleColumnIndex]);
      if (Number.isFinite(staleDays) && staleDays > STALE_THRESHOLD_DAYS) {
        await client.setSheetStyle(spreadsheetToken, `${sheet.id}!${col}${index + 2}:${col}${index + 2}`, {
          backColor: "#F4CCCC",
        });
      }
    }
  }
}

async function writeVisibleSheet(client, spreadsheetToken, sheet, definition) {
  const oldValues = await readRangeOrEmpty(client, spreadsheetToken, `${sheet.id}!A1:M${MAX_VISIBLE_ROWS}`);
  const rowCount = Math.max(oldValues.length, definition.rows.length + 1, 2);
  const values = matrixForSheet(definition.headers, definition.rows, rowCount);
  const lastCol = colName(definition.headers.length - 1);
  await client.writeSheetRange(spreadsheetToken, `${sheet.id}!A1:${lastCol}${rowCount}`, values);
  await styleVisibleSheet(client, spreadsheetToken, sheet, definition, rowCount);
}

export async function writeWatchtowerLiveSheetReport(rows, {
  client,
  spreadsheetToken,
  spreadsheetUrl,
  reportDate = new Date().toISOString().slice(0, 10),
  preshipThresholdHours = 48,
  inTransitThresholdHours = 120,
} = {}) {
  if (!client) {
    throw new Error("Missing required Feishu client");
  }
  if (!spreadsheetToken) {
    throw new Error("Missing required Watchtower spreadsheet token");
  }

  const sheetsByTitle = await ensureSheets(client, spreadsheetToken);
  const hiddenActionEntries = await actionLogFromSheet(client, spreadsheetToken, sheetsByTitle.get(ACTION_LOG_SHEET));
  const checkedEntries = await checkedActionsFromLiveSheets(client, spreadsheetToken, sheetsByTitle, reportDate);
  const actionEntries = mergeActionEntries([...hiddenActionEntries, ...checkedEntries]);
  const report = buildWatchtowerSheetReport(rows, {
    actionEntries,
    reportDate,
    preshipThresholdHours,
    inTransitThresholdHours,
  });

  for (const definition of report.sheets) {
    const sheet = sheetsByTitle.get(definition.name);
    await writeVisibleSheet(client, spreadsheetToken, sheet, definition);
  }
  await writeActionLogSheet(client, spreadsheetToken, sheetsByTitle.get(ACTION_LOG_SHEET), actionEntries);

  return {
    spreadsheetToken,
    spreadsheetUrl,
    actionLogCsv: serializeActionLog(actionEntries),
    findings: report.findings,
    sheets: report.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.length + 1,
    })),
    actionLog: {
      entries: actionEntries.length,
      summaryCount: summarizeActionsByOt(actionEntries).size,
    },
  };
}
