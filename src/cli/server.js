import { getDv1SourceRefreshConfig, getFeishuConfig, getServerConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createLanternServer } from "../server/http.js";
import { startWatchtowerScheduler } from "../watchtower/scheduler.js";
import { refreshDv1SourceSnapshots, startDv1SourceRefreshScheduler } from "../dv1/sourceUpdater.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const config = getServerConfig();
const feishuConfig = getFeishuConfig();
const watchtowerConfig = getWatchtowerConfig();
const dv1SourceRefreshConfig = getDv1SourceRefreshConfig();
const replyClient = new FeishuOpenApiClient(feishuConfig);
const server = createLanternServer({
  serverConfig: config,
  feishuConfig,
  watchtowerConfig,
  replyClient,
});
const watchtowerScheduler = startWatchtowerScheduler({
  watchtowerConfig,
  replyClient,
});
const lanternRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dv1SourceScheduler = startDv1SourceRefreshScheduler({
  enabled: dv1SourceRefreshConfig.enabled,
  intervalMs: dv1SourceRefreshConfig.intervalMs,
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
    catalogOutputPath: join(lanternRoot, "src/dv1/data/reference-catalog.json"),
    soloShippingOutputPath: join(lanternRoot, "src/dv1/data/solo-shipping-costs.json"),
  }),
});

server.listen(config.port, () => {
  console.error(`Lantern web service listening on port ${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`Lantern web service stopping (${signal})...`);
    watchtowerScheduler.stop();
    dv1SourceScheduler.stop();
    server.close(() => {
      console.error("Lantern web service stopped.");
    });
  });
}
