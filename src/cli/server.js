import { getDv1KnownSolutionConfig, getDv1SourceRefreshConfig, getFeishuConfig, getServerConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createLanternServer } from "../server/http.js";
import { startWatchtowerScheduler } from "../watchtower/scheduler.js";
import { refreshDv1SourceSnapshots, startDv1SourceRefreshScheduler } from "../dv1/sourceUpdater.js";
import { createDv1KnownCombinationStore } from "../dv1/knownSolutionArchive.js";
import { dv1CatalogBaselinePath, dv1CostsBaselinePath, dv1SourceSnapshotPath } from "../dv1/plan.js";

const config = getServerConfig();
const feishuConfig = getFeishuConfig();
const watchtowerConfig = getWatchtowerConfig();
const dv1SourceRefreshConfig = getDv1SourceRefreshConfig();
const dv1KnownSolutionConfig = getDv1KnownSolutionConfig();
const replyClient = new FeishuOpenApiClient(feishuConfig);
const dv1KnownCombinations = createDv1KnownCombinationStore({
  feishuClient: replyClient,
  config: dv1KnownSolutionConfig,
});
const dv1KnownSolutionArchiveEnabled = Boolean(dv1KnownSolutionConfig.spreadsheetToken && dv1KnownSolutionConfig.sheetId);
if (dv1KnownSolutionArchiveEnabled) {
  try {
    await dv1KnownCombinations.hydrateFromRemote();
    await dv1KnownCombinations.flushPending();
    console.error("[dv1] known-solution archive hydrated from Feishu");
  } catch (error) {
    console.error(`[dv1] known-solution archive hydration failed; local buffer remains active: ${error.message}`);
  }
}
const server = createLanternServer({
  serverConfig: config,
  feishuConfig,
  watchtowerConfig,
  replyClient,
  dv1KnownCombinations,
  dv1KnownSolutionArchiveEnabled,
});
const watchtowerScheduler = startWatchtowerScheduler({
  watchtowerConfig,
  replyClient,
});
const { alertChatId } = dv1SourceRefreshConfig;
const dv1SourceScheduler = startDv1SourceRefreshScheduler({
  enabled: dv1SourceRefreshConfig.enabled,
  intervalMs: dv1SourceRefreshConfig.intervalMs,
  sendRejectionAlert: alertChatId
    ? (message, options) => replyClient.sendTextMessage(alertChatId, message, options)
    : undefined,
  refresh: () => refreshDv1SourceSnapshots({
    feishuClient: replyClient,
    catalog: {
      spreadsheetToken: dv1SourceRefreshConfig.catalogSpreadsheetToken,
      sheetId: dv1SourceRefreshConfig.catalogSheetId,
      maxRows: dv1SourceRefreshConfig.maxRows,
    },
    fedex: {
      spreadsheetToken: dv1SourceRefreshConfig.fedexSpreadsheetToken,
      sheetId: dv1SourceRefreshConfig.fedexSheetId,
      maxRows: dv1SourceRefreshConfig.maxRows,
    },
    catalogBaselinePath: dv1CatalogBaselinePath,
    costsBaselinePath: dv1CostsBaselinePath,
    minCoverage: dv1SourceRefreshConfig.minCoverage,
    snapshotPath: dv1SourceSnapshotPath,
  }),
});
const dv1KnownSolutionTimer = setInterval(async () => {
  if (!dv1KnownSolutionArchiveEnabled) return;
  try {
    await dv1KnownCombinations.hydrateFromRemote();
    const result = await dv1KnownCombinations.flushPending();
    if (result.persisted > 0) console.error(`[dv1] known-solution archive persisted ${result.persisted} record(s)`);
  } catch (error) {
    console.error(`[dv1] known-solution archive sync failed; will retry: ${error.message}`);
  }
}, dv1KnownSolutionConfig.syncIntervalMs);
dv1KnownSolutionTimer.unref?.();

server.listen(config.port, () => {
  console.error(`Lantern web service listening on port ${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`Lantern web service stopping (${signal})...`);
    watchtowerScheduler.stop();
    dv1SourceScheduler.stop();
    clearInterval(dv1KnownSolutionTimer);
    dv1KnownCombinations.close().finally(() => server.close(() => {
      console.error("Lantern web service stopped.");
    }));
  });
}
