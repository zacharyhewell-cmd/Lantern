import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

function lanternMessageFilter(chatId) {
  if (!chatId) {
    throw new Error("Missing Feishu Lantern chat ID");
  }

  return `select(.chat_id == "${chatId}" and .message_type == "text" and (.content | test("^Lantern\\\\b"; "i")))`;
}

function spawnLanternConsumer({ chatId, timeout, maxEvents }) {
  const args = [
    "event",
    "consume",
    "im.message.receive_v1",
    "--as",
    "bot",
    "--jq",
    lanternMessageFilter(chatId),
  ];

  if (timeout) {
    args.push("--timeout", timeout);
  }

  if (maxEvents != null) {
    args.push("--max-events", String(maxEvents));
  }

  return spawn("lark-cli", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function listenForOneLanternMessage({ chatId, timeout = "3m" }) {
  const child = spawnLanternConsumer({ chatId, timeout, maxEvents: 1 });

  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const lines = createInterface({ input: child.stdout });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    lines.on("line", (line) => {
      if (settled || !line.trim()) {
        return;
      }

      settled = true;
      child.stdin.end();

      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`Could not parse Feishu event: ${error.message}`));
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      if (code === 0) {
        reject(new Error(`No matching Lantern message received. ${stderr.trim()}`));
      } else {
        reject(new Error(`Feishu listener failed with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export function listenForLanternMessages({ chatId, onMessage }) {
  if (typeof onMessage !== "function") {
    throw new Error("Missing Lantern message handler");
  }

  const child = spawnLanternConsumer({ chatId });
  const lines = createInterface({ input: child.stdout });
  let queue = Promise.resolve();

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk.toString());
  });

  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    queue = queue.then(async () => {
      let event;
      try {
        event = JSON.parse(line);
      } catch (error) {
        console.error(`Could not parse Feishu event: ${error.message}`);
        return;
      }

      await onMessage(event);
    }).catch((error) => {
      console.error(`Lantern message handling failed: ${error.message}`);
    });
  });

  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      queue.finally(() => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Feishu listener failed with ${code}`));
        }
      });
    });
  });

  return {
    child,
    closed,
    stop() {
      child.stdin.end();
    },
  };
}
