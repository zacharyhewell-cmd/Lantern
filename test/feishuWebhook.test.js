import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeishuWebhookProcessor,
  extractMessageEvent,
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
