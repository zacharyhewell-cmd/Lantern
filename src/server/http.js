import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFedExConfig, getFeishuConfig, getServerConfig, getShopifyConfig, getSurpathConfig, getWatchtowerConfig } from "../config.js";
import { FeishuOpenApiClient } from "../feishu/openApi.js";
import { createFeishuWebhookProcessor } from "../feishu/webhook.js";
import { runWatchtowerOutboundDelayReport } from "../watchtower/runOutboundDelayReport.js";
import { isoDate, runAndPostWatchtowerReport } from "../watchtower/feishuReportJob.js";
import { loadDv1PlanningData } from "../dv1/data.js";
import { planDv1Order } from "../dv1/plan.js";
import { lookupOwnedOrderTracking } from "../tracking/surpathTracking.js";
import { toLighthouseOrder } from "../lighthouse/publicOrder.js";
import { createLighthouseRateLimiter } from "../lighthouse/rateLimit.js";
import { matchesShippingPostalCode, normalizeCustomerEmail } from "../lighthouse/verification.js";
import { createLighthouseSessions, lighthouseSessionCookie } from "../lighthouse/auth.js";
import { createLighthouseAccounts, validLighthousePassword } from "../lighthouse/accounts.js";

const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "../../public");
const dv1PublicDirectory = join(publicRoot, "dv1");
const lighthousePublicDirectory = join(publicRoot, "lighthouse");
const lighthouseBrandAssets = new Map([
  ["/lighthouse/logo.svg", ["logo.svg", "image/svg+xml"]],
  ["/lighthouse/inter-variable.woff2", ["inter-variable.woff2", "font/woff2"]],
]);

async function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      const error = new Error("Request body is too large.");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function requestPath(request) {
  return new URL(request.url, "http://localhost").pathname;
}

const LIGHTHOUSE_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function sendLighthouseJson(response, status, body, headers = {}) {
  sendJson(response, status, body, { ...LIGHTHOUSE_SECURITY_HEADERS, ...headers });
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

function isAuthorizedDv1Ui(request, serverConfig) {
  if (!serverConfig.dv1UiUsername || !serverConfig.dv1UiPassword) {
    return false;
  }

  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded === `${serverConfig.dv1UiUsername}:${serverConfig.dv1UiPassword}`;
}

function requireDv1Ui(request, response, serverConfig) {
  if (isAuthorizedDv1Ui(request, serverConfig)) {
    return true;
  }

  response.writeHead(401, { "WWW-Authenticate": 'Basic realm="DV1"' });
  response.end("DV1 authentication required.");
  return false;
}

async function sendDv1Asset(response, fileName, contentType) {
  const contents = await readFile(join(dv1PublicDirectory, fileName));
  response.writeHead(200, { "Content-Type": contentType });
  response.end(contents);
}

function isAuthorizedLighthouseUi(request, serverConfig) {
  if (serverConfig.lighthousePublicEnabled) {
    return true;
  }

  if (!serverConfig.lighthouseUiUsername || !serverConfig.lighthouseUiPassword) {
    return false;
  }

  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  return decoded === `${serverConfig.lighthouseUiUsername}:${serverConfig.lighthouseUiPassword}`;
}

function requireLighthouseUi(request, response, serverConfig) {
  if (isAuthorizedLighthouseUi(request, serverConfig)) {
    return true;
  }

  response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Lighthouse"' });
  response.end("Lighthouse authentication required.");
  return false;
}

async function sendLighthouseAsset(response, fileName, contentType) {
  const contents = await readFile(join(lighthousePublicDirectory, fileName));
  response.writeHead(200, { "Content-Type": contentType, ...LIGHTHOUSE_SECURITY_HEADERS });
  response.end(contents);
}

export function createLanternServer({
  serverConfig = getServerConfig(),
  feishuConfig = getFeishuConfig(),
  watchtowerConfig = getWatchtowerConfig(),
  replyClient = new FeishuOpenApiClient(feishuConfig),
  watchtowerRunner = runWatchtowerOutboundDelayReport,
  dv1DataLoader = loadDv1PlanningData,
  dv1PlanRunner = planDv1Order,
  dv1KnownCombinations,
  dv1KnownSolutionArchiveEnabled,
  lighthouseLookup = lookupOwnedOrderTracking,
  lighthouseAccounts = createLighthouseAccounts({
    directory: serverConfig.lighthouseAccountsDirectory,
    setupSecret: serverConfig.lighthouseSetupSecret,
  }),
  lighthouseSessions = createLighthouseSessions(),
  lighthousePresenter = toLighthouseOrder,
  lighthouseRateLimiter,
  processor,
} = {}) {
  const rateLimiter = lighthouseRateLimiter || createLighthouseRateLimiter({
    maxRequests: serverConfig.lighthouseRateLimitMax,
    windowMs: serverConfig.lighthouseRateLimitWindowMs,
  });
  const loginAccountLimiter = createLighthouseRateLimiter({ maxRequests: 8, windowMs: 60_000 });
  const loginServiceLimiter = createLighthouseRateLimiter({ maxRequests: 100, windowMs: 60_000 });
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
        const health = {
          ok: true,
          service: "lantern",
        };
        if (dv1KnownSolutionArchiveEnabled !== undefined) {
          health.knownSolutionArchive = dv1KnownSolutionArchiveEnabled ? "feishu" : "local";
        }
        sendJson(response, 200, health);
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

      if (pathname === "/dv1" || pathname === "/dv1/" || pathname === "/dv1/index.html") {
        if (!requireDv1Ui(request, response, serverConfig)) {
          return;
        }
        await sendDv1Asset(response, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (pathname === "/dv1/app.js") {
        if (!requireDv1Ui(request, response, serverConfig)) {
          return;
        }
        await sendDv1Asset(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }

      if (pathname === "/dv1/styles.css") {
        if (!requireDv1Ui(request, response, serverConfig)) {
          return;
        }
        await sendDv1Asset(response, "styles.css", "text/css; charset=utf-8");
        return;
      }

      if (request.method === "POST" && pathname === serverConfig.dv1PlanPath) {
        if (!requireDv1Ui(request, response, serverConfig)) {
          return;
        }

        const payload = await readJsonBody(request);
        const orderNumber = String(payload.orderNumber || "").trim();
        if (!orderNumber) {
          sendJson(response, 400, { error: "orderNumber is required" });
          return;
        }

        const result = await dv1PlanRunner({
          orderNumber,
          shopifyConfig: getShopifyConfig(),
          surpathConfig: getSurpathConfig(),
          knownCombinations: dv1KnownCombinations,
        });
        if (!result) {
          sendJson(response, 404, { error: `No Shopify order found for ${orderNumber}.` });
          return;
        }

        sendJson(response, 200, result);
        return;
      }

      if (pathname === "/lighthouse" || pathname === "/lighthouse/" || pathname === "/lighthouse/index.html") {
        if (!requireLighthouseUi(request, response, serverConfig)) {
          return;
        }
        await sendLighthouseAsset(response, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (pathname === "/lighthouse/app.js") {
        if (!requireLighthouseUi(request, response, serverConfig)) {
          return;
        }
        await sendLighthouseAsset(response, "app.js", "text/javascript; charset=utf-8");
        return;
      }

      if (pathname === "/lighthouse/styles.css") {
        if (!requireLighthouseUi(request, response, serverConfig)) {
          return;
        }
        await sendLighthouseAsset(response, "styles.css", "text/css; charset=utf-8");
        return;
      }

      const brandAsset = lighthouseBrandAssets.get(pathname);
      if (brandAsset) {
        if (!requireLighthouseUi(request, response, serverConfig)) {
          return;
        }
        await sendLighthouseAsset(response, ...brandAsset);
        return;
      }

      if (pathname === "/lighthouse/setup" && request.method === "POST") {
        if (!requireLighthouseUi(request, response, serverConfig)) return;
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
          sendLighthouseJson(response, 415, { error: "Expected a JSON request." });
          return;
        }
        let payload;
        try {
          payload = await readJsonBody(request, { maxBytes: 4096 });
        } catch (error) {
          sendLighthouseJson(response, error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: "Invalid setup request." });
          return;
        }
        if (!validLighthousePassword(payload?.password)) {
          sendLighthouseJson(response, 400, { error: "Use a password between 15 and 128 characters." });
          return;
        }
        try {
          const account = await lighthouseAccounts.setPassword(payload);
          if (!account) {
            sendLighthouseJson(response, 400, { error: "This setup link is invalid, expired, or already used." });
            return;
          }
          lighthouseSessions.revokeEmail(account.email);
          lighthouseSessions.revoke(request);
          sendLighthouseJson(response, 200, { passwordSet: true }, { "Set-Cookie": lighthouseSessionCookie("") });
        } catch (error) {
          if (error.code !== "LIGHTHOUSE_AUTH_BUSY") console.error("Lighthouse password setup unavailable");
          sendLighthouseJson(response, 503, { error: "Password setup is temporarily unavailable. Please try again." });
        }
        return;
      }

      if (pathname === "/lighthouse/session" && ["GET", "POST", "DELETE"].includes(request.method)) {
        if (!requireLighthouseUi(request, response, serverConfig)) return;
        if (request.method === "GET") {
          sendLighthouseJson(response, 200, { signedIn: Boolean(lighthouseSessions.get(request)) });
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
          sendLighthouseJson(response, 415, { error: "Expected a JSON request." });
          return;
        }
        if (request.method === "DELETE") {
          lighthouseSessions.revoke(request);
          sendLighthouseJson(response, 200, { signedIn: false }, { "Set-Cookie": lighthouseSessionCookie("") });
          return;
        }

        let credentials;
        try {
          credentials = await readJsonBody(request, { maxBytes: 4096 });
        } catch (error) {
          sendLighthouseJson(response, error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, { error: "Enter your email and password." });
          return;
        }
        const email = normalizeCustomerEmail(credentials?.email);
        const password = credentials?.password;
        if (!email || typeof password !== "string" || !password.length || password.length > 128) {
          sendLighthouseJson(response, 400, { error: "Enter your email and password." });
          return;
        }
        const serviceLimit = loginServiceLimiter.check("all");
        const limit = serviceLimit.allowed ? loginAccountLimiter.check(email) : serviceLimit;
        if (!limit.allowed) {
          sendLighthouseJson(response, 429, { error: "Too many sign-in attempts. Please wait and try again." }, {
            "Retry-After": String(limit.retryAfterSeconds),
          });
          return;
        }

        try {
          const identity = await lighthouseAccounts.authenticate({ email, password });
          if (!identity || normalizeCustomerEmail(identity.email) !== email) {
            sendLighthouseJson(response, 401, { error: "We could not sign you in with that email and password." });
            return;
          }
          lighthouseSessions.revoke(request);
          const cookie = lighthouseSessions.issue(identity);
          if (!cookie) throw new Error("Could not create Lighthouse session");
          sendLighthouseJson(response, 200, { signedIn: true }, { "Set-Cookie": cookie });
        } catch (error) {
          if (error.code !== "LIGHTHOUSE_AUTH_BUSY") console.error("Lighthouse customer sign-in unavailable");
          sendLighthouseJson(response, 503, { error: "Sign-in is temporarily unavailable. Please try again later." });
        }
        return;
      }

      if (request.method === "POST" && pathname === serverConfig.lighthouseLookupPath) {
        if (!requireLighthouseUi(request, response, serverConfig)) {
          return;
        }

        const session = lighthouseSessions.get(request);
        if (!session) {
          sendLighthouseJson(response, 401, { error: "Please sign in to look up an order." });
          return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
          sendLighthouseJson(response, 415, { error: "Expected a JSON request." });
          return;
        }

        const rateLimit = rateLimiter.check(session.email);
        if (!rateLimit.allowed) {
          sendLighthouseJson(response, 429, {
            error: "Too many lookup requests. Please wait a moment and try again.",
          }, {
            "Retry-After": String(rateLimit.retryAfterSeconds),
          });
          return;
        }

        let payload;
        try {
          payload = await readJsonBody(request, { maxBytes: 16 * 1024 });
        } catch (error) {
          sendLighthouseJson(response, error.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
            error: "Enter a valid order number and shipping postal code.",
          });
          return;
        }
        const orderNumber = typeof payload?.orderNumber === "string" ? payload.orderNumber.trim() : "";
        const postalCode = typeof payload?.postalCode === "string" ? payload.postalCode.trim() : "";
        if (!orderNumber || orderNumber.length > 64 || !postalCode || postalCode.length > 32) {
          sendLighthouseJson(response, 400, { error: "Enter a valid order number and shipping postal code." });
          return;
        }

        let summary;
        try {
          summary = await lighthouseLookup({
            orderText: orderNumber,
            ownerEmail: session.email,
            postalCode,
            shopifyConfig: getShopifyConfig(),
            surpathConfig: getSurpathConfig(),
            fedExConfig: getFedExConfig(),
          });
        } catch {
          console.error("Lighthouse lookup failed");
          sendLighthouseJson(response, 503, {
            error: "We could not retrieve that order right now. Please try again shortly.",
          });
          return;
        }

        if (lighthouseSessions.get(request) !== session) {
          sendLighthouseJson(response, 401, { error: "Please sign in to look up an order." });
          return;
        }
        if (!summary?.found || !matchesShippingPostalCode(summary, postalCode)) {
          sendLighthouseJson(response, 404, {
            error: "We could not verify an order with those details.",
          });
          return;
        }

        sendLighthouseJson(response, 200, lighthousePresenter(summary));
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });
}
