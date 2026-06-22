import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeishuWebhookProcessor,
  extractMessageEvent,
  isWatchtowerRefreshTrigger,
  verificationResponse,
} from "../src/feishu/webhook.js";

test("responds to Feishu URL verification challenge", () => {
  assert.deepEqual(verificationResponse({
    type: "url_verification",
    token: "verify-token",
    challenge: "challenge-value",
  }, "verify-token"), {
    status: 200,
    body: { challenge: "challenge-value" },
  });
});

test("extracts text content from Feishu v2 message event", () => {
  const event = extractMessageEvent({
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      token: "verify-token",
    },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_test",
        message_type: "text",
        content: "{\"text\":\"Lantern 32303\"}",
      },
    },
  });

  assert.deepEqual(event, {
    eventId: "evt-1",
    eventType: "im.message.receive_v1",
    token: "verify-token",
    chatId: "oc_test",
    messageId: "om_test",
    messageType: "text",
    content: "Lantern 32303",
  });
});

test("ignores non-Lantern webhook messages", async () => {
  const replies = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async () => "should not be called",
  });

  const result = await processor({
    header: { event_id: "evt-2", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_test",
        message_type: "text",
        content: "{\"text\":\"hello\"}",
      },
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ignored, "trigger");
  assert.deepEqual(replies, []);
});

test("detects Watchtower refresh trigger exactly", () => {
  assert.equal(isWatchtowerRefreshTrigger("Watchtower refresh"), true);
  assert.equal(isWatchtowerRefreshTrigger(" watchtower   refresh "), true);
  assert.equal(isWatchtowerRefreshTrigger("Watchtower refresh please"), false);
  assert.equal(isWatchtowerRefreshTrigger("Lantern 32146"), false);
});

test("runs Watchtower refresh from Feishu trigger", async () => {
  const replies = [];
  const refreshes = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async () => "should not be called",
    watchtowerRefreshHandler: async (event, dedupeKey) => {
      refreshes.push({ event, dedupeKey });
      return { source: { rows: 42 } };
    },
  });

  const result = await processor({
    header: { event_id: "evt-watchtower-1", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_watchtower",
        message_type: "text",
        content: "{\"text\":\"Watchtower refresh\"}",
      },
    },
  });

  assert.equal(result.status, 200);
  await result.afterResponse;
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].dedupeKey, "evt-watchtower-1");
  assert.deepEqual(replies, [
    [
      "om_watchtower",
      "Watchtower refresh started. I will post the updated report when it is ready.",
      { idempotencyKey: "evt-watchtower-1-watchtower-started" },
    ],
    [
      "om_watchtower",
      "Watchtower refresh complete. Source rows scanned: 42.",
      { idempotencyKey: "evt-watchtower-1-watchtower-complete" },
    ],
  ]);
});

test("replies in-thread and dedupes Feishu retry events", async () => {
  const replies = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    verificationToken: "verify-token",
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async (content) => `reply for ${content}`,
  });
  const payload = {
    header: {
      event_id: "evt-3",
      event_type: "im.message.receive_v1",
      token: "verify-token",
    },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_test",
        message_type: "text",
        content: "{\"text\":\"Lantern WS-#32303\"}",
      },
    },
  };

  const firstResult = await processor(payload);
  assert.equal(firstResult.status, 200);
  assert.deepEqual(firstResult.body, { ok: true });
  await firstResult.afterResponse;
  assert.deepEqual(await processor(payload), { status: 200, body: { ok: true, duplicate: true } });
  assert.deepEqual(replies, [[
    "om_test",
    "reply for Lantern WS-#32303",
    { idempotencyKey: "evt-3" },
  ]]);
});

test("accepts any configured allowed chat ID", async () => {
  const replies = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatIds: ["oc_test", "oc_shipping"],
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async (content) => `reply for ${content}`,
  });

  const result = await processor({
    header: { event_id: "evt-4", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_shipping",
        message_id: "om_shipping",
        message_type: "text",
        content: "{\"text\":\"Lantern 32146\"}",
      },
    },
  });

  assert.equal(result.status, 200);
  await result.afterResponse;
  assert.deepEqual(replies, [[
    "om_shipping",
    "reply for Lantern 32146",
    { idempotencyKey: "evt-4" },
  ]]);
});

test("still rejects chats outside the allowed chat ID set", async () => {
  const processor = createFeishuWebhookProcessor({
    allowedChatIds: ["oc_test", "oc_shipping"],
    replyClient: {
      async replyInThread() {},
    },
    buildReply: async () => "should not be called",
  });

  const result = await processor({
    header: { event_id: "evt-5", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_other",
        message_id: "om_other",
        message_type: "text",
        content: "{\"text\":\"Lantern 32146\"}",
      },
    },
  });

  assert.deepEqual(result, { status: 200, body: { ok: true, ignored: "chat" } });
});
