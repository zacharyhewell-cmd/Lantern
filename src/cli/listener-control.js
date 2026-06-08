import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const pidFile = join("var", "lantern-listener.pid");
const logFile = join("var", "lantern-listener.log");

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid() {
  try {
    return Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return null;
  }
}

function removePidFile() {
  try {
    rmSync(pidFile);
  } catch {
    // Nothing to remove.
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function light() {
  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    console.log(`Lantern is already lit. Listener pid: ${existingPid}`);
    return;
  }

  removePidFile();
  mkdirSync(dirname(pidFile), { recursive: true });
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, ["src/cli/listen.js"], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  writeFileSync(pidFile, String(child.pid));
  await wait(1500);

  if (isRunning(child.pid)) {
    console.log(`Lantern is lit. Listener pid: ${child.pid}`);
  } else {
    removePidFile();
    console.log(`Lantern did not stay lit. Check ${logFile}.`);
    process.exitCode = 1;
  }
}

async function extinguish() {
  const pid = readPid();
  if (!pid || !isRunning(pid)) {
    removePidFile();
    console.log("Lantern is already extinguished.");
    return;
  }

  process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(250);
    if (!isRunning(pid)) {
      removePidFile();
      console.log("Lantern is extinguished.");
      return;
    }
  }

  console.log(`Lantern is still stopping. Listener pid: ${pid}`);
}

const command = process.argv[2]?.toLowerCase();
if (command === "light") {
  await light();
} else if (command === "extinguish") {
  await extinguish();
} else {
  console.error("Use: npm run light or npm run extinguish");
  process.exit(1);
}
