import { createServer } from "node:http";
import { getFeishuConfig, getServerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createFeishuWebhookProcessor } from "../feishu/webhook.js";

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

export function createLanternServer({
  serverConfig = getServerConfig(),
  feishuConfig = getFeishuConfig(),
  replyClient = new FeishuOpenApiClient(feishuConfig),
  processor = createFeishuWebhookProcessor({
    allowedChatId: feishuConfig.lanternChatId,
    verificationToken: feishuConfig.verificationToken,
    replyClient,
  }),
} = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        sendJson(response, 200, { ok: true, service: "lantern" });
        return;
      }

      if (request.method === "POST" && request.url === serverConfig.feishuWebhookPath) {
        const payload = await readJsonBody(request);
        const result = await processor(payload);
        sendJson(response, result.status, result.body);
        result.afterResponse?.catch?.((error) => {
          console.error(`Lantern webhook background task failed: ${error.message}`);
        });
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });
}
