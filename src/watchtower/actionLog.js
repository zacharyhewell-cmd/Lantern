import { normalizeSurpathStatus } from "../surpath/status.js";

function escapeCsv(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}

function normalizeOtNumber(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    return "";
  }

  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeRule(value) {
  return String(value || "").trim().toLowerCase();
}

function actionRecordKey(entry) {
  return `${normalizeRule(entry.rule) || "legacy"}|${normalizeOtNumber(entry.otNumber)}`;
}

export function parseActionLog(csvText = "") {
  const lines = String(csvText || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    return [];
  }

  const [headerLine, ...dataLines] = lines;
  const headers = parseCsvLine(headerLine).map((header) => header.trim());
  const otIndex = headers.findIndex((header) => /^ot number$/i.test(header));
  const ruleIndex = headers.findIndex((header) => /^rule$/i.test(header));
  const countIndex = headers.findIndex((header) => /^action count$/i.test(header));
  const lastDateIndex = headers.findIndex((header) => /^last action date$/i.test(header));
  const dateIndex = headers.findIndex((header) => /^action date$/i.test(header));

  if (otIndex < 0 || (dateIndex < 0 && lastDateIndex < 0)) {
    return [];
  }

  return dataLines
    .map(parseCsvLine)
    .map((cells) => {
      const actionDate = normalizeDate(cells[lastDateIndex >= 0 ? lastDateIndex : dateIndex]);
      return {
        otNumber: normalizeOtNumber(cells[otIndex]),
        ...(ruleIndex >= 0 ? { rule: normalizeRule(cells[ruleIndex]) } : {}),
        ...(countIndex >= 0 ? { actionCount: Number(cells[countIndex]) || 0 } : {}),
        actionDate,
        ...(lastDateIndex >= 0 ? { lastActionDate: actionDate } : {}),
      };
    })
    .filter((entry) => entry.otNumber && entry.actionDate);
}

export function parseActionLogRows(values = []) {
  if (!values?.length) {
    return [];
  }

  const headers = values[0].map((value) => String(value || "").trim().toLowerCase());
  const otIndex = headers.indexOf("ot number");
  const ruleIndex = headers.indexOf("rule");
  const countIndex = headers.indexOf("action count");
  const lastDateIndex = headers.indexOf("last action date");
  const dateIndex = headers.indexOf("action date");
  if (otIndex < 0 || (lastDateIndex < 0 && dateIndex < 0)) {
    return [];
  }

  return values.slice(1)
    .map((row) => {
      const lastActionDate = normalizeDate(row[lastDateIndex >= 0 ? lastDateIndex : dateIndex]);
      return {
        otNumber: normalizeOtNumber(row[otIndex]),
        ...(ruleIndex >= 0 ? { rule: normalizeRule(row[ruleIndex]) } : {}),
        actionCount: countIndex >= 0 ? Number(row[countIndex]) || 0 : 1,
        lastActionDate,
      };
    })
    .filter((record) => record.otNumber && record.lastActionDate);
}

export function serializeActionLog(entries = []) {
  const normalized = compactActionLogEntries(entries);
  return [
    "OT number,Rule,Action count,Last action date",
    ...normalized.map((entry) => [
      entry.otNumber,
      entry.rule,
      entry.actionCount,
      entry.lastActionDate,
    ].map(escapeCsv).join(",")),
    "",
  ].join("\n");
}

export function mergeActionEntries(entries = []) {
  const unique = new Map();
  for (const entry of entries) {
    const otNumber = normalizeOtNumber(entry.otNumber);
    const actionDate = normalizeDate(entry.actionDate);
    if (!otNumber || !actionDate) {
      continue;
    }

    unique.set(`${otNumber}|${actionDate}`, { otNumber, actionDate });
  }

  return [...unique.values()].sort((left, right) => (
    left.otNumber.localeCompare(right.otNumber) ||
    left.actionDate.localeCompare(right.actionDate)
  ));
}

export function compactActionLogEntries(entries = []) {
  const records = new Map();
  const rawDatesByKey = new Map();
  for (const entry of entries) {
    const otNumber = normalizeOtNumber(entry.otNumber);
    const actionDate = normalizeDate(entry.lastActionDate || entry.actionDate);
    if (!otNumber || !actionDate) {
      continue;
    }

    const key = actionRecordKey(entry);
    const incomingCount = Number(entry.actionCount);
    if (!(Number.isFinite(incomingCount) && incomingCount > 0)) {
      const rawDates = rawDatesByKey.get(key) || new Set();
      if (rawDates.has(actionDate)) {
        continue;
      }
      rawDates.add(actionDate);
      rawDatesByKey.set(key, rawDates);
    }

    const existing = records.get(key) || {
      otNumber,
      rule: normalizeRule(entry.rule) || "legacy",
      actionCount: 0,
      lastActionDate: "",
    };
    existing.actionCount += Number.isFinite(incomingCount) && incomingCount > 0 ? incomingCount : 1;
    if (!existing.lastActionDate || actionDate > existing.lastActionDate) {
      existing.lastActionDate = actionDate;
    }
    records.set(key, existing);
  }

  return [...records.values()].sort((left, right) => (
    left.otNumber.localeCompare(right.otNumber) ||
    left.rule.localeCompare(right.rule)
  ));
}

export function mergeActionRecords(records = [], checkedEntries = []) {
  const merged = new Map();
  for (const record of compactActionLogEntries(records)) {
    merged.set(actionRecordKey(record), record);
  }

  for (const entry of checkedEntries) {
    const otNumber = normalizeOtNumber(entry.otNumber);
    const actionDate = normalizeDate(entry.actionDate);
    if (!otNumber || !actionDate) {
      continue;
    }

    const key = actionRecordKey(entry);
    let existing = merged.get(key);
    if (!existing) {
      const legacyKey = `legacy|${otNumber}`;
      const legacy = merged.get(legacyKey);
      if (legacy) {
        merged.delete(legacyKey);
        legacy.rule = normalizeRule(entry.rule) || "legacy";
        existing = legacy;
        merged.set(key, existing);
      }
    }
    if (!existing) {
      merged.set(key, {
        otNumber,
        rule: normalizeRule(entry.rule) || "legacy",
        actionCount: 1,
        lastActionDate: actionDate,
      });
      continue;
    }

    if (existing.lastActionDate !== actionDate) {
      existing.actionCount += 1;
      existing.lastActionDate = existing.lastActionDate > actionDate
        ? existing.lastActionDate
        : actionDate;
    }
  }

  return [...merged.values()].sort((left, right) => (
    left.otNumber.localeCompare(right.otNumber) ||
    left.rule.localeCompare(right.rule)
  ));
}

export function summarizeActionsByOt(entries = []) {
  const summary = new Map();
  for (const entry of compactActionLogEntries(entries)) {
    const existing = summary.get(entry.otNumber) || {
      actionTaken: false,
      actionCount: 0,
      lastActionDate: "",
    };
    if (!existing.actionDates) {
      Object.defineProperty(existing, "actionDates", {
        value: new Set(),
        enumerable: false,
      });
    }

    existing.actionTaken = true;
    existing.actionCount += entry.actionCount;
    existing.actionDates.add(entry.lastActionDate);
    existing.lastActionDate = existing.lastActionDate && existing.lastActionDate > entry.lastActionDate
      ? existing.lastActionDate
      : entry.lastActionDate;
    summary.set(entry.otNumber, existing);
  }

  return summary;
}

function rowIdentifiers(row) {
  return [
    row?.platformCode,
    row?.referenceCode,
    row?.expressNumber,
    row?.bolCode,
    row?.wmsOutboundCode,
    row?.id,
  ]
    .map(normalizeOtNumber)
    .filter(Boolean);
}

function rowIsTerminal(row) {
  const status = String(row?.status || "").trim().toLowerCase();
  return Boolean(row?.deliveredDate) ||
    normalizeSurpathStatus(row?.status) === "Delivered" ||
    status.includes("canceled") ||
    status.includes("cancelled") ||
    status.includes("已取消");
}

function rowHasOutboundDate(row) {
  return Boolean(row?.actualOutboundDate) || rowIsTerminal(row);
}

export function actionRecordIsClosed(record, rows = []) {
  const target = normalizeOtNumber(record?.otNumber);
  if (!target) {
    return false;
  }

  const matchingRows = (rows || []).filter((row) => rowIdentifiers(row).includes(target));
  if (!matchingRows.length) {
    return false;
  }

  const rule = normalizeRule(record.rule);
  if (rule === "preship_delay") {
    return matchingRows.every(rowHasOutboundDate);
  }

  if (rule === "in_transit_delay") {
    return matchingRows.every(rowIsTerminal);
  }

  return matchingRows.every(rowIsTerminal);
}

export function removeClosedActionRecords(records = [], rows = []) {
  return compactActionLogEntries(records).filter((record) => !actionRecordIsClosed(record, rows));
}
