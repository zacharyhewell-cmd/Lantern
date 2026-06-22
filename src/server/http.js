import { createServer } from "node:http";
import { getFeishuConfig, getServerConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createFeishuWebhookProcessor } from "../feishu/webhook.js";
import { runWatchtowerOutboundDelayReport } from "../watchtower/runOutboundDelayReport.js";
import { isoDate, runAndPostWatchtowerReport } from "../watchtower/feishuReportJob.js";

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function requestPath(request) {
  return new URL(request.url, "http://localhost").pathname;
}

function isAuthorizedWatchtowerRequest(request, watchtowerConfig) {
  if (!watchtowerConfig.runSecret) {
    return false;
  }

  const authorization = request.headers.authorization || "";
  return authorization === `Bearer ${watchtowerConfig.runSecret}`;
}

export function createLanternServer({
  serverConfig = getServerConfig(),
  feishuConfig = getFeishuConfig(),
  watchtowerConfig = getWatchtowerConfig(),
  replyClient = new FeishuOpenApiClient(feishuConfig),
  watchtowerRunner = runWatchtowerOutboundDelayReport,
  processor,
} = {}) {
  const webhookProcessor = processor || createFeishuWebhookProcessor({
    allowedChatIds: feishuConfig.allowedChatIds,
    verificationToken: feishuConfig.verificationToken,
    replyClient,
    watchtowerRefreshHandler: async () => runAndPostWatchtowerReport({
      watchtowerConfig,
      replyClient,
      watchtowerRunner,
      runDate: isoDate(),
    }),
  });

  return createServer(async (request, response) => {
    try {
      const pathname = requestPath(request);

      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "lantern" });
        return;
      }

      if (request.method === "POST" && pathname === serverConfig.feishuWebhookPath) {
        const payload = await readJsonBody(request);
        const result = await webhookProcessor(payload);
        sendJson(response, result.status, result.body);
        result.afterResponse?.catch?.((error) => {
          console.error(`Lantern webhook background task failed: ${error.message}`);
        });
        return;
      }

      if (request.method === "POST" && pathname === watchtowerConfig.runPath) {
        if (!isAuthorizedWatchtowerRequest(request, watchtowerConfig)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }

        const result = await runAndPostWatchtowerReport({
          watchtowerConfig,
          replyClient,
          watchtowerRunner,
          runDate: isoDate(),
        });

        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });
}
