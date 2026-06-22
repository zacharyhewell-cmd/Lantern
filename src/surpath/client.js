import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function parseToolResult(result) {
  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayFromRateLimit(error) {
  const match = String(error?.message || "").match(/"resetAtEpochSecond":(\d+)/);
  if (!match) {
    return null;
  }

  const delay = Number(match[1]) * 1000 - Date.now() + 1000;
  if (delay < 0 || delay > 180000) {
    return null;
  }

  return delay;
}

function retryDelayFromTransientError(error) {
  const message = String(error?.message || "");
  const causeCode = error?.cause?.code || "";
  if (
    message.includes("fetch failed") ||
    message.includes("Connect Timeout") ||
    causeCode === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return 5000;
  }

  return null;
}

function summarizeQuery(params) {
  return JSON.stringify({
    platformCodeCount: params.platformCodeList?.length || 0,
    hasZip: Boolean(params.zip),
    skuCount: params.skuList?.length || 0,
    createTimeStart: params.createTimeStart,
    createTimeEnd: params.createTimeEnd,
    pageSize: params.pageSize,
  });
}

async function callToolWithRateLimitRetry(client, request, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      console.error(`[surpath] queryOutboundOrders attempt=${attempt + 1} ${summarizeQuery(request.arguments || {})}`);
      return await client.callTool(request);
    } catch (error) {
      lastError = error;
      const delay = retryDelayFromRateLimit(error) ?? retryDelayFromTransientError(error);
      if (delay == null || attempt === attempts - 1) {
        console.error(`[surpath] queryOutboundOrders failed attempt=${attempt + 1}: ${error.message}`);
        throw error;
      }

      console.error(`[surpath] rate limited; waiting ${Math.ceil(delay / 1000)}s before retry`);
      await sleep(delay);
    }
  }

  throw lastError;
}

export class SurpathMcpClient {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
  }

  isConfigured() {
    return Boolean(this.config?.mcpUrl);
  }

  async connect() {
    if (this.client) {
      return;
    }

    if (!this.isConfigured()) {
      throw new Error("Missing Surpath MCP URL");
    }

    try {
      await this.connectWithTransport(new StreamableHTTPClientTransport(new URL(this.config.mcpUrl)));
    } catch (streamableError) {
      try {
        await this.connectWithTransport(new SSEClientTransport(new URL(this.config.mcpUrl)));
      } catch (sseError) {
        throw new Error(`Could not connect to Surpath MCP: ${sseError.message || streamableError.message}`);
      }
    }
  }

  async connectWithTransport(transport) {
    const client = new Client({
      name: "lantern",
      version: "0.1.0",
    });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
  }

  async close() {
    await this.transport?.close?.();
    this.client = null;
    this.transport = null;
  }

  async queryOutboundOrders(params) {
    await this.connect();
    const result = await callToolWithRateLimitRetry(this.client, {
      name: "queryOutboundOrders",
      arguments: params,
    });
    return parseToolResult(result);
  }
}
