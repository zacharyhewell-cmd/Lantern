import test from "node:test";
import assert from "node:assert/strict";
import { createLanternServer } from "../src/server/http.js";

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
