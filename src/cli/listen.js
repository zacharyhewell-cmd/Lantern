import { requireEnv } from "../config.js";
import { listenForLanternMessages } from "../feishu/listener.js";
import { replyInThread } from "../feishu/larkCli.js";
import { buildLanternReply } from "../lantern/reply.js";

const chatId = requireEnv("FEISHU_LANTERN_CHAT_ID");

console.error("Lantern listener starting...");

const listener = listenForLanternMessages({
  chatId,
  async onMessage(event) {
    console.error(`Lantern request received: ${event.message_id}`);
    const reply = await buildLanternReply(event.content);
    if (reply) {
      await replyInThread(event.message_id, reply);
    }
    console.error(`Replied in-thread to ${event.message_id}`);
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.error(`Lantern listener stopping (${signal})...`);
    listener.stop();
  });
}

try {
  await listener.closed;
  console.error("Lantern listener stopped.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
