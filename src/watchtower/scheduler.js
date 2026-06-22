import { runAndPostWatchtowerReport } from "./feishuReportJob.js";

function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function shouldRunWatchtowerSchedule(now, {
  timeZone,
  hour,
  minute,
  lastRunDateKey,
}) {
  const local = localParts(now, timeZone);
  const weekday = !["Sat", "Sun"].includes(local.weekday);
  return weekday &&
    local.hour === hour &&
    local.minute === minute &&
    local.dateKey !== lastRunDateKey;
}

export function startWatchtowerScheduler({
  watchtowerConfig,
  replyClient,
  watchtowerRunner,
  intervalMs = 60 * 1000,
  now = () => new Date(),
} = {}) {
  if (!watchtowerConfig.scheduleEnabled) {
    return { stop() {} };
  }

  let running = false;
  let lastRunDateKey = null;

  async function tick() {
    if (running) {
      return;
    }

    const current = now();
    const local = localParts(current, watchtowerConfig.scheduleTimeZone);
    if (!shouldRunWatchtowerSchedule(current, {
      timeZone: watchtowerConfig.scheduleTimeZone,
      hour: watchtowerConfig.scheduleHour,
      minute: watchtowerConfig.scheduleMinute,
      lastRunDateKey,
    })) {
      return;
    }

    running = true;
    lastRunDateKey = local.dateKey;
    try {
      console.error(`[watchtower] scheduled report started for ${local.dateKey}`);
      await runAndPostWatchtowerReport({
        watchtowerConfig,
        replyClient,
        watchtowerRunner,
        runDate: local.dateKey,
      });
      console.error(`[watchtower] scheduled report finished for ${local.dateKey}`);
    } catch (error) {
      console.error(`[watchtower] scheduled report failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  console.error(`[watchtower] scheduler enabled for ${String(watchtowerConfig.scheduleHour).padStart(2, "0")}:${String(watchtowerConfig.scheduleMinute).padStart(2, "0")} ${watchtowerConfig.scheduleTimeZone}`);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
