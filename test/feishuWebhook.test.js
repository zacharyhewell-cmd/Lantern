import test from "node:test";
import assert from "node:assert/strict";
import {
  createFeishuWebhookProcessor,
  extractMessageEvent,
  isWatchtowerRefreshTrigger,
  verificationResponse,
} from "../src/feishu/webhook.js";
import { createLighthouseSetupLink } from "../src/lighthouse/invite.js";

test("issues a Lighthouse setup link only to an approved operator in a verified Feishu DM", async () => {
  const replies = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_existing_group",
    verificationToken: "verify-token",
    lighthouseInviteOperatorIds: ["ou_allowed"],
    lighthouseInviteHandler: (email) => createLighthouseSetupLink(
      email, "https://lighthouse.example/lighthouse", "example-test-secret-at-least-32-bytes",
    ),
    replyClient: { async replyInThread(...args) { replies.push(args); } },
    logger: {},
  });
  const request = ({
    chatType = "p2p", openId = "ou_allowed", token = "verify-token",
    content = "Lighthouse invite Dealer@Example.com", messageId = "om_test",
  } = {}) => ({
    header: { event_type: "im.message.receive_v1", token },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: openId } },
      message: {
        message_id: messageId, chat_id: "oc_direct", chat_type: chatType, message_type: "text",
        content: JSON.stringify({ text: content }),
      },
    },
  });

  for (const overrides of [
    { chatType: "group" }, { openId: "ou_unapproved" }, { token: "" }, { token: "wrong" },
  ]) {
    const denied = await processor(request(overrides));
    assert.equal(denied.afterResponse, undefined);
  }
  assert.deepEqual(replies, []);

  const idLookup = await processor(request({
    openId: "ou_unapproved", content: "Lighthouse invite-id", messageId: "om_id",
  }));
  await idLookup.afterResponse;
  assert.deepEqual(replies.shift(), ["om_id", "Your Lantern bot ID is ou_unapproved.", { replyInThread: false }]);

  const accepted = await processor(request());
  await accepted.afterResponse;
  assert.equal(replies.length, 1);
  const [messageId, text, options] = replies[0];
  assert.equal(messageId, "om_test");
  assert.deepEqual(options, { replyInThread: false });
  const link = new URL(text.split("\n").at(-1));
  assert.equal(link.origin + link.pathname, "https://lighthouse.example/lighthouse");
  const token = new URLSearchParams(link.hash.slice(1)).get("setup");
  const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url"));
  assert.equal(claims.email, "dealer@example.com");
  assert.equal((await processor(request())).body.duplicate, true);
});

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

test("routes WTF sheet lookups to the sheet handler", async () => {
  const replies = [];
  const lookups = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async () => "should not be called",
    buildWtfReply: async (content) => {
      lookups.push(content);
      return `sheet reply for ${content}`;
    },
  });

  const result = await processor({
    header: { event_id: "evt-wtf-1", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_wtf",
        message_type: "text",
        content: "{\"text\":\"WTF WS-#37974\"}",
      },
    },
  });

  assert.equal(result.status, 200);
  await result.afterResponse;
  assert.deepEqual(lookups, ["WTF WS-#37974"]);
  assert.deepEqual(replies, [[
    "om_wtf",
    "sheet reply for WTF WS-#37974",
    { idempotencyKey: "evt-wtf-1" },
  ]]);
});

test("runs Watchtower refresh even when status replies fail", async () => {
  const warnings = [];
  const refreshes = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    replyClient: {
      async replyInThread() {
        throw new Error("Feishu reply failed: 99992402 field validation failed");
      },
    },
    buildReply: async () => "should not be called",
    watchtowerRefreshHandler: async (event, dedupeKey) => {
      refreshes.push({ event, dedupeKey });
      return { source: { rows: 42 } };
    },
  });

  const result = await processor({
    header: { event_id: "evt-watchtower-2", event_type: "im.message.receive_v1" },
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
  assert.equal(refreshes[0].dedupeKey, "evt-watchtower-2");
  assert.equal(warnings.length, 2);
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

test("replies in-thread to near-miss Lantern trigger spellings", async () => {
  const replies = [];
  const processor = createFeishuWebhookProcessor({
    allowedChatId: "oc_test",
    replyClient: {
      async replyInThread(...args) {
        replies.push(args);
      },
    },
    buildReply: async () => "Lantern. L A N T E R N. Lantern.",
  });

  const result = await processor({
    header: { event_id: "evt-misspell", event_type: "im.message.receive_v1" },
    event: {
      message: {
        chat_id: "oc_test",
        message_id: "om_misspell",
        message_type: "text",
        content: "{\"text\":\"Lantren 32146\"}",
      },
    },
  });

  assert.equal(result.status, 200);
  await result.afterResponse;
  assert.deepEqual(replies, [[
    "om_misspell",
    "Lantern. L A N T E R N. Lantern.",
    { idempotencyKey: "evt-misspell" },
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
