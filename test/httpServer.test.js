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
