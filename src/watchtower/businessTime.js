const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

function dateTimeFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function zonedParts(value, timeZone) {
  const parts = Object.fromEntries(
    dateTimeFormatter(timeZone)
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value]),
  );

  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function wallClockMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function zonedDateTimeToUtcMs(parts, timeZone) {
  const targetWallTime = wallClockMs(parts);
  let guess = targetWallTime;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actualParts = zonedParts(guess, timeZone);
    const actualWallTime = wallClockMs(actualParts);
    const diff = targetWallTime - actualWallTime;
    if (diff === 0) {
      break;
    }
    guess += diff;
  }

  return guess;
}

function localDayMs(value, timeZone) {
  const parts = zonedParts(value, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function businessWindowForDay(dayMs, timeZone, { startHour, endHour }) {
  const baseDate = new Date(dayMs);
  const dayParts = {
    year: baseDate.getUTCFullYear(),
    month: baseDate.getUTCMonth() + 1,
    day: baseDate.getUTCDate(),
  };
  const noonUtc = zonedDateTimeToUtcMs({ ...dayParts, hour: 12, minute: 0, second: 0 }, timeZone);
  const weekday = zonedParts(noonUtc, timeZone).weekday;
  if (!WEEKDAYS.has(weekday)) {
    return null;
  }

  return {
    start: zonedDateTimeToUtcMs({ ...dayParts, hour: startHour, minute: 0, second: 0 }, timeZone),
    end: zonedDateTimeToUtcMs({ ...dayParts, hour: endHour, minute: 0, second: 0 }, timeZone),
  };
}

export function businessHoursBetween(startValue, endValue, {
  timeZone = "America/Los_Angeles",
  startHour = 9,
  endHour = 17,
} = {}) {
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }

  let hours = 0;
  const firstDay = localDayMs(start, timeZone);
  const lastDay = localDayMs(end, timeZone);

  for (let dayMs = firstDay; dayMs <= lastDay; dayMs += DAY_MS) {
    const window = businessWindowForDay(dayMs, timeZone, { startHour, endHour });
    if (!window) {
      continue;
    }

    const overlapStart = Math.max(start, window.start);
    const overlapEnd = Math.min(end, window.end);
    if (overlapEnd > overlapStart) {
      hours += (overlapEnd - overlapStart) / HOUR_MS;
    }
  }

  return hours;
}

export function businessTimeZoneForWarehouse(warehouseCode) {
  const code = String(warehouseCode || "").toUpperCase();
  if (/^(GA|NJ)-/.test(code)) {
    return "America/New_York";
  }

  if (/^(LA)-/.test(code) || code === "SPLALS1" || code === "SPUSLA") {
    return "America/Los_Angeles";
  }

  if (code === "TX-LST5") {
    return "America/Chicago";
  }

  return "America/Los_Angeles";
}
