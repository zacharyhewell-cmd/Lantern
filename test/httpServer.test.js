import test from "node:test";
import assert from "node:assert/strict";
import { createLanternServer } from "../src/server/http.js";

process.env.SHOPIFY_SHOP_DOMAIN = "shopify.example";
process.env.SURPATH_MCP_URL = "https://surpath.example/mcp";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test("serves health check and Feishu webhook path", async () => {
  const calls = [];
  const server = createLanternServer({
    serverConfig: { port: 0, feishuWebhookPath: "/feishu/events" },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    replyClient: {
      async replyInThread() {},
    },
    processor: async (payload) => {
      calls.push(payload);
      return { status: 200, body: { ok: true } };
    },
  });

  const port = await listen(server);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: "lantern" });

    const webhook = await fetch(`http://127.0.0.1:${port}/feishu/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(await webhook.json(), { ok: true });
    assert.deepEqual(calls, [{ type: "url_verification", challenge: "abc" }]);
  } finally {
    await close(server);
  }
});

test("runs Watchtower report from authorized endpoint and posts to Feishu", async () => {
  const sent = [];
  const runnerCalls = [];
  const server = createLanternServer({
    serverConfig: { port: 0, feishuWebhookPath: "/feishu/events" },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    watchtowerConfig: {
      runPath: "/watchtower/run",
      runSecret: "secret",
      chatId: "oc_logistics",
      outputDir: "outputs/watchtower",
      createTimeLookbackDays: 30,
      preshipThresholdHours: 48,
      inTransitThresholdHours: 120,
    },
    replyClient: {
      async replyInThread() {},
      async sendTextMessage(...args) {
        sent.push(["text", ...args]);
      },
      async sendFileMessage(...args) {
        sent.push(["file", ...args]);
      },
    },
    watchtowerRunner: async (options) => {
      runnerCalls.push(options);
      return {
        outputPath: "/tmp/watchtower.xlsx",
        source: { rows: 123 },
        findings: { preship: 1, inTransit: 2 },
      };
    },
  });

  const port = await listen(server);
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/watchtower/run`, { method: "POST" });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/watchtower/run`, {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
    });
    assert.equal(authorized.status, 200);
    const body = await authorized.json();
    assert.equal(body.ok, true);
    assert.equal(body.postedToFeishu, true);
    assert.equal(body.source.rows, 123);
    assert.equal(runnerCalls.length, 1);
    assert.equal(runnerCalls[0].outputDir, "outputs/watchtower");
    assert.equal(runnerCalls[0].preshipThresholdHours, 48);
    assert.equal(sent.length, 2);
    assert.equal(sent[0][0], "text");
    assert.equal(sent[0][1], "oc_logistics");
    assert.match(sent[0][2], /Watchtower report/);
    assert.equal(sent[1][0], "file");
    assert.equal(sent[1][1], "oc_logistics");
    assert.equal(sent[1][2], "/tmp/watchtower.xlsx");
  } finally {
    await close(server);
  }
});

test("serves the protected DV1 live-data endpoint", async () => {
  const server = createLanternServer({
    serverConfig: {
      port: 0,
      feishuWebhookPath: "/feishu/events",
      dv1DataPath: "/dv1/data",
      dv1DataApiSecret: "dv1-secret",
    },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    replyClient: { async replyInThread() {} },
    dv1DataLoader: async ({ orderNumber }) => ({
      order: { orderNumber, warehouseId: "LA-SPI1", lines: [] },
      inventory: { warehouseId: "LA-SPI1", items: [] },
    }),
  });

  const port = await listen(server);
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/dv1/data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: "WS-#10001" }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/dv1/data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dv1-secret",
      },
      body: JSON.stringify({ orderNumber: "WS-#10001" }),
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).order.orderNumber, "WS-#10001");
  } finally {
    await close(server);
  }
});

test("serves the protected DV1 planning screen and plan route", async () => {
  const server = createLanternServer({
    serverConfig: {
      port: 0,
      feishuWebhookPath: "/feishu/events",
      dv1PlanPath: "/dv1/plan",
      dv1UiUsername: "operator",
      dv1UiPassword: "password",
    },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    replyClient: { async replyInThread() {} },
    dv1PlanRunner: async ({ orderNumber }) => ({
      order: { orderNumber },
      plan: { status: "ready", shipments: [], exceptions: [], ignoredLines: [] },
    }),
  });

  const port = await listen(server);
  const authorization = `Basic ${Buffer.from("operator:password").toString("base64")}`;
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/dv1`);
    assert.equal(unauthorized.status, 401);

    const page = await fetch(`http://127.0.0.1:${port}/dv1`, {
      headers: { Authorization: authorization },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Plan an order/);

    const plan = await fetch(`http://127.0.0.1:${port}/dv1/plan`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orderNumber: "WS-#10001" }),
    });
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).order.orderNumber, "WS-#10001");
  } finally {
    await close(server);
  }
});

test("serves the protected Lighthouse page and structured lookup route", async () => {
  const lookupCalls = [];
  let lookupError = null;
  const server = createLanternServer({
    serverConfig: {
      port: 0,
      feishuWebhookPath: "/feishu/events",
      lighthouseLookupPath: "/lighthouse/lookup",
      lighthouseUiUsername: "reviewer",
      lighthouseUiPassword: "password",
    },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    replyClient: { async replyInThread() {} },
    lighthouseLookup: async (options) => {
      if (lookupError) {
        throw lookupError;
      }
      lookupCalls.push(options);
      return {
        found: true,
        orderName: "WS-#32303",
        verification: { shippingPostalCode: "97214" },
        shipments: [],
        unfulfilledItems: [],
        warnings: [],
      };
    },
  });

  const port = await listen(server);
  const authorization = `Basic ${Buffer.from("reviewer:password").toString("base64")}`;
  try {
    const unauthorizedPage = await fetch(`http://127.0.0.1:${port}/lighthouse`);
    assert.equal(unauthorizedPage.status, 401);

    const page = await fetch(`http://127.0.0.1:${port}/lighthouse`, {
      headers: { Authorization: authorization },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<img src="\/lighthouse\/logo\.svg" alt="Velotric Order Tracker"/);

    for (const [asset, contentType] of [
      ["logo.svg", "image/svg+xml"],
      ["inter-variable.woff2", "font/woff2"],
    ]) {
      const url = `http://127.0.0.1:${port}/lighthouse/${asset}`;
      const unauthorizedAsset = await fetch(url);
      assert.equal(unauthorizedAsset.status, 401);
      const authorizedAsset = await fetch(url, { headers: { Authorization: authorization } });
      assert.equal(authorizedAsset.status, 200);
      assert.equal(authorizedAsset.headers.get("content-type"), contentType);
    }

    const unauthorizedLookup = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: "32303", postalCode: "97214" }),
    });
    assert.equal(unauthorizedLookup.status, 401);

    const malformedLookup = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: "{",
    });
    assert.equal(malformedLookup.status, 400);
    assert.deepEqual(await malformedLookup.json(), {
      error: "Enter a valid order number and shipping postal code.",
    });
    assert.equal(lookupCalls.length, 0);

    const lookup = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orderNumber: "32303", postalCode: "97214" }),
    });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.headers.get("cache-control"), "no-store");
    assert.match(lookup.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.deepEqual(await lookup.json(), {
      found: true,
      orderNumber: "WS-#32303",
      cancelledAt: null,
      unfulfilledItems: [],
      shipments: [],
      warnings: [],
    });
    assert.equal(lookupCalls.length, 1);
    assert.equal(lookupCalls[0].orderText, "32303");

    const mismatch = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orderNumber: "32303", postalCode: "00000" }),
    });
    assert.equal(mismatch.status, 404);
    const mismatchBody = await mismatch.json();
    assert.match(mismatchBody.error, /could not verify/i);
    assert.doesNotMatch(JSON.stringify(mismatchBody), /32303|97214/);

    lookupError = new Error("private upstream detail");
    const failedLookup = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ orderNumber: "32303", postalCode: "97214" }),
    });
    assert.equal(failedLookup.status, 503);
    const failureBody = await failedLookup.json();
    assert.match(failureBody.error, /could not retrieve/i);
    assert.doesNotMatch(JSON.stringify(failureBody), /private upstream detail/);
  } finally {
    await close(server);
  }
});

test("requires an explicit switch before Lighthouse accepts public requests", async () => {
  const server = createLanternServer({
    serverConfig: {
      port: 0,
      feishuWebhookPath: "/feishu/events",
      lighthouseLookupPath: "/lighthouse/lookup",
      lighthousePublicEnabled: true,
    },
    feishuConfig: {
      appId: "app-id",
      appSecret: "app-secret",
      verificationToken: "verify-token",
      lanternChatId: "oc_test",
    },
    replyClient: { async replyInThread() {} },
    lighthouseLookup: async () => ({
      found: true,
      orderName: "WS-#32303",
      verification: { shippingPostalCode: "97214" },
      shipments: [],
      unfulfilledItems: [],
      warnings: [],
    }),
  });

  const port = await listen(server);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/lighthouse`);
    assert.equal(page.status, 200);

    const lookup = await fetch(`http://127.0.0.1:${port}/lighthouse/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber: "32303", postalCode: "97214" }),
    });
    assert.equal(lookup.status, 200);
  } finally {
    await close(server);
  }
});
