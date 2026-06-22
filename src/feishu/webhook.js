import { buildLanternReply, isLanternTrigger } from "../lantern/reply.js";

const WATCHTOWER_REFRESH_PATTERN = /^\s*watchtower\s+refresh\s*$/i;

function parseContent(content) {
  if (content == null) {
    return "";
  }

  if (typeof content === "object") {
    return content.text || content.content || "";
  }

  const value = String(content);
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed.text || parsed.content || value;
    }
  } catch {
    // Plain text event content from local tools is already useful.
  }

  return value;
}

export function extractMessageEvent(payload) {
  const event = payload?.event || payload;
  const message = event?.message || event;
  const content = parseContent(message?.content ?? event?.content ?? payload?.content);

  return {
    eventId: payload?.header?.event_id || payload?.event_id || message?.message_id,
    eventType: payload?.header?.event_type || payload?.event_type || payload?.type,
    token: payload?.header?.token || payload?.token,
    chatId: message?.chat_id || event?.chat_id,
    messageId: message?.message_id || event?.message_id || payload?.message_id,
    messageType: message?.message_type || event?.message_type,
    content,
  };
}

export function verificationResponse(payload, verificationToken) {
  if (payload?.type !== "url_verification" || !payload?.challenge) {
    return null;
  }

  if (verificationToken && payload.token !== verificationToken) {
    return {
      status: 403,
      body: { error: "invalid verification token" },
    };
  }

  return {
    status: 200,
    body: { challenge: payload.challenge },
  };
}

export function isWatchtowerRefreshTrigger(content) {
  return WATCHTOWER_REFRESH_PATTERN.test(String(content || ""));
}

export function createFeishuWebhookProcessor({
  allowedChatId,
  allowedChatIds,
  verificationToken,
  replyClient,
  buildReply = buildLanternReply,
  watchtowerRefreshHandler,
  processedIds = new Set(),
  logger = console,
} = {}) {
  if (!replyClient?.replyInThread) {
    throw new Error("Missing Feishu reply client");
  }

  const allowedChats = new Set([
    allowedChatId,
    ...(allowedChatIds || []),
  ].filter(Boolean));

  return async function processFeishuWebhook(payload) {
    const verification = verificationResponse(payload, verificationToken);
    if (verification) {
      logger.info?.(`Feishu webhook verification request: status=${verification.status}`);
      return verification;
    }

    if (payload?.encrypt) {
      logger.error?.("Feishu webhook received encrypted payload; encrypted callbacks are not enabled in Lantern yet");
      return { status: 400, body: { error: "encrypted callbacks are not supported" } };
    }

    const event = extractMessageEvent(payload);
    if (verificationToken && event.token && event.token !== verificationToken) {
      logger.error?.("Feishu webhook rejected event: invalid verification token");
      return { status: 403, body: { error: "invalid event token" } };
    }

    if (event.eventType && !["im.message.receive_v1", "message"].includes(event.eventType)) {
      logger.info?.(`Feishu webhook ignored event: event_type=${event.eventType}`);
      return { status: 200, body: { ok: true, ignored: "event_type" } };
    }

    if (allowedChats.size && !allowedChats.has(event.chatId)) {
      logger.info?.(`Feishu webhook ignored event: chat=${event.chatId || "missing"}`);
      return { status: 200, body: { ok: true, ignored: "chat" } };
    }

    if (event.messageType && event.messageType !== "text") {
      logger.info?.(`Feishu webhook ignored event: message_type=${event.messageType}`);
      return { status: 200, body: { ok: true, ignored: "message_type" } };
    }

    const isLanternRequest = isLanternTrigger(event.content);
    const isWatchtowerRefreshRequest = isWatchtowerRefreshTrigger(event.content);

    if (!event.messageId || (!isLanternRequest && !isWatchtowerRefreshRequest)) {
      logger.info?.(
        `Feishu webhook ignored event: trigger message_id=${event.messageId ? "present" : "missing"}`,
      );
      return { status: 200, body: { ok: true, ignored: "trigger" } };
    }

    const dedupeKey = event.eventId || event.messageId;
    if (processedIds.has(dedupeKey)) {
      logger.info?.(`Feishu webhook ignored event: duplicate=${dedupeKey}`);
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    processedIds.add(dedupeKey);
    logger.info?.(`Feishu webhook accepted ${isWatchtowerRefreshRequest ? "Watchtower refresh" : "Lantern"} request: event=${dedupeKey}`);

    const afterResponse = (async () => {
      if (isWatchtowerRefreshRequest) {
        if (!watchtowerRefreshHandler) {
          await replyClient.replyInThread(event.messageId, "Watchtower refresh is not configured on this Lantern service yet.", {
            idempotencyKey: `${dedupeKey}-watchtower-unconfigured`,
          });
          return;
        }

        await replyClient.replyInThread(event.messageId, "Watchtower refresh started. I will post the updated report when it is ready.", {
          idempotencyKey: `${dedupeKey}-watchtower-started`,
        });
        const result = await watchtowerRefreshHandler(event, dedupeKey);
        await replyClient.replyInThread(
          event.messageId,
          `Watchtower refresh complete. Source rows scanned: ${result.source?.rows ?? "unknown"}.`,
          { idempotencyKey: `${dedupeKey}-watchtower-complete` },
        );
        return;
      }

      const reply = await buildReply(event.content);
      if (reply) {
        await replyClient.replyInThread(event.messageId, reply, {
          idempotencyKey: dedupeKey,
        });
      }
    })().catch((error) => {
      processedIds.delete(dedupeKey);
      logger.error?.(`Feishu webhook processing failed: ${error.message}`);
    });

    return { status: 200, body: { ok: true }, afterResponse };
  };
}
