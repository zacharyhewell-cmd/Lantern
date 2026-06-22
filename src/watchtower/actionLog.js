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

export function parseActionLog(csvText = "") {
  const lines = String(csvText || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    return [];
  }

  const [headerLine, ...dataLines] = lines;
  const headers = parseCsvLine(headerLine).map((header) => header.trim());
  const otIndex = headers.findIndex((header) => /^ot number$/i.test(header));
  const dateIndex = headers.findIndex((header) => /^action date$/i.test(header));

  if (otIndex < 0 || dateIndex < 0) {
    return [];
  }

  return dataLines
    .map(parseCsvLine)
    .map((cells) => ({
      otNumber: normalizeOtNumber(cells[otIndex]),
      actionDate: normalizeDate(cells[dateIndex]),
    }))
    .filter((entry) => entry.otNumber && entry.actionDate);
}

export function serializeActionLog(entries = []) {
  const normalized = mergeActionEntries(entries);
  return [
    "OT number,Action date",
    ...normalized.map((entry) => [entry.otNumber, entry.actionDate].map(escapeCsv).join(",")),
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

export function summarizeActionsByOt(entries = []) {
  const summary = new Map();
  for (const entry of mergeActionEntries(entries)) {
    const existing = summary.get(entry.otNumber) || {
      actionTaken: false,
      actionCount: 0,
      lastActionDate: "",
    };

    existing.actionTaken = true;
    existing.actionCount += 1;
    existing.lastActionDate = existing.lastActionDate && existing.lastActionDate > entry.actionDate
      ? existing.lastActionDate
      : entry.actionDate;
    summary.set(entry.otNumber, existing);
  }

  return summary;
}
