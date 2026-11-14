import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { normalizeCustomerEmail } from "./verification.js";

const derive = promisify(scrypt);
const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const DUMMY_SALT = randomBytes(16).toString("hex");
const hashPassword = (password, salt) => derive(password, salt, 64, {
  N: 32768, r: 8, p: 3, maxmem: 40 * 1024 * 1024,
});
const sign = (payload, secret) => createHmac("sha256", secret)
  .update("lighthouse-password-setup:")
  .update(payload)
  .digest();

function validateSecret(secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("Lighthouse setup secret is not configured");
}

export function issueLighthouseSetupToken(email, secret, now = Date.now()) {
  validateSecret(secret);
  const approvedEmail = normalizeCustomerEmail(email);
  if (!approvedEmail) throw new Error("Enter a valid, approved customer email.");
  const payload = Buffer.from(JSON.stringify({
    email: approvedEmail, issuedAt: now, nonce: randomBytes(16).toString("hex"),
  })).toString("base64url");
  return `${payload}.${sign(payload, secret).toString("base64url")}`;
}

function readSetupToken(token, secret, now) {
  if (typeof token !== "string" || token.length > 1024 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [payload, signature] = token.split(".");
  if (!timingSafeEqual(sign(payload, secret), Buffer.from(signature, "base64url"))) return null;
  try {
    const { email, issuedAt } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt >= SETUP_TTL_MS ||
      !email || normalizeCustomerEmail(email) !== email) return null;
    return { email, issuedAt };
  } catch {
    return null;
  }
}

export function validLighthousePassword(password) {
  return typeof password === "string" && password.length >= 15 && password.length <= 128;
}

export function createLighthouseAccounts({ directory, setupSecret, now = Date.now } = {}) {
  // One service instance owns this directory. A per-email lock keeps password
  // setup and sign-in from racing with an invitation or a password reset.
  const busy = new Set();
  let active = 0;
  async function withAccount(email, work) {
    if (!directory || !isAbsolute(directory)) throw new Error("Lighthouse accounts directory is not configured");
    if (busy.has(email) || active >= 2) {
      const error = new Error("Lighthouse authentication is busy");
      error.code = "LIGHTHOUSE_AUTH_BUSY";
      throw error;
    }
    busy.add(email);
    active += 1;
    try {
      const key = createHash("sha256").update(email).digest("hex");
      const path = join(directory, `${key}.json`);
      let account = null;
      try {
        account = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return await work(account, path);
    } finally {
      active -= 1;
      busy.delete(email);
    }
  }

  return {
    authenticate({ email, password }) {
      return withAccount(email, async (account) => {
        const actual = await hashPassword(password, account?.salt || DUMMY_SALT);
        const expected = account ? Buffer.from(account.hash, "hex") : Buffer.alloc(64);
        return timingSafeEqual(actual, expected) && account ? { email } : null;
      });
    },

    async setPassword({ token, password }) {
      validateSecret(setupSecret);
      const setup = readSetupToken(token, setupSecret, now());
      if (!setup || !validLighthousePassword(password)) return null;
      return withAccount(setup.email, async (account, path) => {
        if (account && setup.issuedAt <= account.issuedAt) return null;
        const salt = randomBytes(16).toString("hex");
        const hash = (await hashPassword(password, salt)).toString("hex");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ salt, hash, issuedAt: setup.issuedAt }), { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        return { email: setup.email };
      });
    },
  };
}
