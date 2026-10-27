import { createServer } from "node:http";
import { getFeishuConfig, getServerConfig, getShopifyConfig, getSurpathConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createFeishuWebhookProcessor } from "../feishu/webhook.js";
import { runWatchtowerOutboundDelayReport } from "../watchtower/runOutboundDelayReport.js";
import { isoDate, runAndPostWatchtowerReport } from "../watchtower/feishuReportJob.js";
import { loadDv1PlanningData } from "../dv1/data.js";

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

function isAuthorizedDv1Request(request, serverConfig) {
  if (!serverConfig.dv1DataApiSecret) {
    return false;
  }

  return request.headers.authorization === `Bearer ${serverConfig.dv1DataApiSecret}`;
}

export function createLanternServer({
  serverConfig = getServerConfig(),
  feishuConfig = getFeishuConfig(),
  watchtowerConfig = getWatchtowerConfig(),
  replyClient = new FeishuOpenApiClient(feishuConfig),
  watchtowerRunner = runWatchtowerOutboundDelayReport,
  dv1DataLoader = loadDv1PlanningData,
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

      if (request.method === "POST" && pathname === serverConfig.dv1DataPath) {
        if (!isAuthorizedDv1Request(request, serverConfig)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }

        const payload = await readJsonBody(request);
        const orderNumber = String(payload.orderNumber || "").trim();
        if (!orderNumber) {
          sendJson(response, 400, { error: "orderNumber is required" });
          return;
        }

        const result = await dv1DataLoader({
          orderNumber,
          shopifyConfig: getShopifyConfig(),
          surpathConfig: getSurpathConfig(),
        });
        if (!result) {
          sendJson(response, 404, { error: `No Shopify order found for ${orderNumber}.` });
          return;
        }

        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });
}
