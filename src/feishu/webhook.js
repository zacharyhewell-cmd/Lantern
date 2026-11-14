import { buildLanternReply, isLanternRequestTrigger } from "../lantern/reply.js";
import { buildWtfSheetReply, isWtfSheetLookupTrigger } from "../lantern/wtfSheetLookup.js";
import { normalizeCustomerEmail } from "../lighthouse/verification.js";

const WATCHTOWER_REFRESH_PATTERN = /^\s*watchtower\s+refresh\s*$/i;
const LIGHTHOUSE_INVITE_PATTERN = /^\s*lighthouse\s+invite(?:\s+(.*))?\s*$/i;
const LIGHTHOUSE_INVITE_ID_PATTERN = /^\s*lighthouse\s+invite-id\s*$/i;

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

async function tryReplyInThread(replyClient, messageId, text, options, logger, label) {
  try {
    await replyClient.replyInThread(messageId, text, options);
    return true;
  } catch (error) {
    logger.warn?.(`Feishu webhook ${label} reply failed but processing will continue: ${error.message}`);
    return false;
  }
}

export function createFeishuWebhookProcessor({
  allowedChatId,
  allowedChatIds,
  verificationToken,
  replyClient,
  buildReply = buildLanternReply,
  buildWtfReply = (content) => buildWtfSheetReply(content, { feishuClient: replyClient }),
  watchtowerRefreshHandler,
  lighthouseInviteHandler,
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

    const inviteCommand = String(event.content).match(LIGHTHOUSE_INVITE_PATTERN);
    const inviteIdCommand = LIGHTHOUSE_INVITE_ID_PATTERN.test(event.content);
    const isLighthouseCommand = inviteCommand || inviteIdCommand;
    const senderOpenId = payload.event?.sender?.sender_id?.open_id;
    if (isLighthouseCommand) {
      const { sender, message } = payload.event || {};
      if (!verificationToken || payload.header?.token !== verificationToken ||
        payload.header?.event_type !== "im.message.receive_v1" ||
        message?.chat_type !== "p2p" || message.message_type !== "text" ||
        !message.message_id || sender?.sender_type !== "user" ||
        typeof senderOpenId !== "string" || !senderOpenId.startsWith("ou_")) {
        return { status: 200, body: { ok: true, ignored: "invite_access" } };
      }
    } else if (allowedChats.size && !allowedChats.has(event.chatId)) {
      logger.info?.(`Feishu webhook ignored event: chat=${event.chatId || "missing"}`);
      return { status: 200, body: { ok: true, ignored: "chat" } };
    }

    if (event.messageType && event.messageType !== "text") {
      logger.info?.(`Feishu webhook ignored event: message_type=${event.messageType}`);
      return { status: 200, body: { ok: true, ignored: "message_type" } };
    }

    const isLanternRequest = isLanternRequestTrigger(event.content);
    const isWtfSheetLookupRequest = isWtfSheetLookupTrigger(event.content);
    const isWatchtowerRefreshRequest = isWatchtowerRefreshTrigger(event.content);

    if (!event.messageId || (!isLighthouseCommand && !isLanternRequest && !isWtfSheetLookupRequest && !isWatchtowerRefreshRequest)) {
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
    const requestLabel = isLighthouseCommand ? "Lighthouse invite" :
      isWatchtowerRefreshRequest ? "Watchtower refresh" : isWtfSheetLookupRequest ? "WTF sheet lookup" : "Lantern";
    logger.info?.(`Feishu webhook accepted ${requestLabel} request: event=${dedupeKey}`);

    const afterResponse = (async () => {
      if (inviteIdCommand) {
        await replyClient.replyInThread(event.messageId, `Your Lantern bot ID is ${senderOpenId}.`, {
          replyInThread: false,
        });
        return;
      }
      if (inviteCommand) {
        const email = normalizeCustomerEmail(inviteCommand[1]);
        let reply = "Usage: Lighthouse invite dealer@example.com";
        if (email) {
          reply = "Lighthouse invites are unavailable. Ask your Lantern administrator to check the configuration.";
          try {
            const link = await lighthouseInviteHandler?.(email);
            if (link) {
              reply = `One-time Lighthouse link for ${email}. It expires in 24 hours. Share it privately with that address.\n\n${link}`;
            }
          } catch {
            logger.warn?.("Lighthouse invite configuration is unavailable");
          }
        }
        await replyClient.replyInThread(event.messageId, reply, { replyInThread: false });
        return;
      }

      if (isWatchtowerRefreshRequest) {
        if (!watchtowerRefreshHandler) {
          await tryReplyInThread(
            replyClient,
            event.messageId,
            "Watchtower refresh is not configured on this Lantern service yet.",
            { idempotencyKey: `${dedupeKey}-watchtower-unconfigured` },
            logger,
            "Watchtower unconfigured",
          );
          return;
        }

        await tryReplyInThread(
          replyClient,
          event.messageId,
          "Watchtower refresh started. I will post the updated report when it is ready.",
          { idempotencyKey: `${dedupeKey}-watchtower-started` },
          logger,
          "Watchtower started",
        );
        const result = await watchtowerRefreshHandler(event, dedupeKey);
        await tryReplyInThread(
          replyClient,
          event.messageId,
          `Watchtower refresh complete. Source rows scanned: ${result.source?.rows ?? "unknown"}.`,
          { idempotencyKey: `${dedupeKey}-watchtower-complete` },
          logger,
          "Watchtower complete",
        );
        return;
      }

      if (isWtfSheetLookupRequest) {
        const reply = await buildWtfReply(event.content);
        if (reply) {
          await replyClient.replyInThread(event.messageId, reply, {
            idempotencyKey: dedupeKey,
          });
        }
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
      if (isLighthouseCommand) {
        logger.error?.("Feishu Lighthouse invite reply failed");
      } else {
        logger.error?.(`Feishu webhook processing failed: ${error.message}`);
      }
    });

    return { status: 200, body: { ok: true }, afterResponse };
  };
}
