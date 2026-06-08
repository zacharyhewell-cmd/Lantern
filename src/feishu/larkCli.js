import { spawn } from "node:child_process";

export function runLarkCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`lark-cli exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export async function replyInThread(messageId, text) {
  await runLarkCli([
    "im",
    "+messages-reply",
    "--message-id",
    messageId,
    "--text",
    text,
    "--reply-in-thread",
    "--as",
    "bot",
  ]);
}
