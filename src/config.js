import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadLocalEnv() {
  try {
    const envFile = readFileSync(".env", "utf8");
    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]]) {
        continue;
      }

      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // A .env file is optional; deployed environments should set variables directly.
  }
}

loadLocalEnv();

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function readCodexSurpathMcpUrl() {
  try {
    const config = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const sectionMatch = config.match(/\[mcp_servers\.surpath]\s*([\s\S]*?)(?:\n\[|$)/);
    const urlMatch = sectionMatch?.[1]?.match(/url\s*=\s*"([^"]+)"/);
    return urlMatch?.[1] || "";
  } catch {
    return "";
  }
}

function sheetTokenFromUrl(url) {
  const match = String(url || "").match(/\/sheets\/([A-Za-z0-9]+)/);
  return match?.[1] || "";
}

export function getShopifyConfig() {
  return {
    shopDomain: requireEnv("SHOPIFY_SHOP_DOMAIN"),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2026-01",
    adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
  };
}

export function getFedExConfig() {
  return {
    clientId: process.env.FEDEX_CLIENT_ID || "",
    clientSecret: process.env.FEDEX_CLIENT_SECRET || "",
    apiBaseUrl: process.env.FEDEX_API_BASE_URL || "https://apis.fedex.com",
  };
}

export function getSurpathConfig() {
  return {
    mcpUrl: process.env.SURPATH_MCP_URL || readCodexSurpathMcpUrl(),
  };
}

export function getFeishuConfig() {
  const allowedChatIds = [
    process.env.FEISHU_LANTERN_CHAT_ID,
    process.env.FEISHU_ALLOWED_CHAT_IDS,
    process.env.WATCHTOWER_FEISHU_CHAT_ID,
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: requireEnv("FEISHU_APP_SECRET"),
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
    lanternChatId: process.env.FEISHU_LANTERN_CHAT_ID || "",
    allowedChatIds,
    apiBaseUrl: process.env.FEISHU_API_BASE_URL || "https://open.feishu.cn",
  };
}

export function getServerConfig() {
  return {
    port: Number(process.env.PORT || 3000),
    feishuWebhookPath: process.env.FEISHU_WEBHOOK_PATH || "/feishu/events",
  };
}

export function getWatchtowerConfig() {
  const sheetUrl = process.env.WATCHTOWER_SHEET_URL || "";
  return {
    runPath: process.env.WATCHTOWER_RUN_PATH || "/watchtower/run",
    runSecret: process.env.WATCHTOWER_RUN_SECRET || "",
    chatId: process.env.WATCHTOWER_FEISHU_CHAT_ID || "",
    sheetUrl,
    sheetToken: process.env.WATCHTOWER_SHEET_TOKEN || sheetTokenFromUrl(sheetUrl),
    outputDir: process.env.WATCHTOWER_OUTPUT_DIR || "outputs/watchtower",
    createTimeLookbackDays: Number(process.env.WATCHTOWER_CREATE_TIME_LOOKBACK_DAYS || 30),
    preshipThresholdHours: Number(process.env.WATCHTOWER_PRESHIP_THRESHOLD_HOURS || 48),
    inTransitThresholdHours: Number(process.env.WATCHTOWER_IN_TRANSIT_THRESHOLD_HOURS || 120),
    scheduleEnabled: process.env.WATCHTOWER_SCHEDULE_ENABLED === "true",
    scheduleTimeZone: process.env.WATCHTOWER_SCHEDULE_TIME_ZONE || "America/Los_Angeles",
    scheduleHour: Number(process.env.WATCHTOWER_SCHEDULE_HOUR || 22),
    scheduleMinute: Number(process.env.WATCHTOWER_SCHEDULE_MINUTE || 30),
  };
}
