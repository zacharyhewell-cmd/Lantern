import { getFeishuConfig, getServerConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createLanternServer } from "../server/http.js";
import { startWatchtowerScheduler } from "../watchtower/scheduler.js";

const config = getServerConfig();
const feishuConfig = getFeishuConfig();
const watchtowerConfig = getWatchtowerConfig();
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

server.listen(config.port, () => {
  console.error(`Lantern web service listening on port ${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`Lantern web service stopping (${signal})...`);
    watchtowerScheduler.stop();
    server.close(() => {
      console.error("Lantern web service stopped.");
    });
  });
}
