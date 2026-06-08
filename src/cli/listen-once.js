import { requireEnv } from "../config.js";
import { listenForOneLanternMessage } from "../feishu/listener.js";
import { replyInThread } from "../feishu/larkCli.js";
import { buildLanternReply } from "../lantern/reply.js";

const chatId = requireEnv("FEISHU_LANTERN_CHAT_ID");

try {
  console.error("Waiting for one Lantern message...");
  const event = await listenForOneLanternMessage({ chatId });
  const reply = await buildLanternReply(event.content);
  if (reply) {
    await replyInThread(event.message_id, reply);
  }
  console.error(`Replied in-thread to ${event.message_id}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
