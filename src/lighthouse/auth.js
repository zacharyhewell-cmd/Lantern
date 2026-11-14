import { randomBytes } from "node:crypto";
import { normalizeCustomerEmail } from "./verification.js";

const COOKIE_NAME = "__Host-lighthouse";
const SESSION_SECONDS = 30 * 60;

export function lighthouseSessionCookie(token, maxAge = 0) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

export function createLighthouseSessions({ now = Date.now, maxSessions = 5_000 } = {}) {
  const sessions = new Map();
  const tokenFrom = (request) => request.headers.cookie?.match(
    /(?:^|;\s*)__Host-lighthouse=([a-f0-9]{64})(?=;|$)/,
  )?.[1];

  return {
    get(request) {
      const token = tokenFrom(request);
      const session = sessions.get(token);
      if (session?.expiresAt > now()) return session;
      sessions.delete(token);
      return null;
    },
    revoke(request) {
      sessions.delete(tokenFrom(request));
    },
    revokeEmail(email) {
      for (const [token, session] of sessions) {
        if (session.email === email) sessions.delete(token);
      }
    },
    issue({ email }) {
      const currentTime = now();
      const normalizedEmail = normalizeCustomerEmail(email);
      if (!normalizedEmail) return null;
      if (sessions.size >= maxSessions) {
        for (const [token, session] of sessions) {
          if (session.expiresAt <= currentTime) sessions.delete(token);
        }
        if (sessions.size >= maxSessions) return null;
      }
      const token = randomBytes(32).toString("hex");
      sessions.set(token, { email: normalizedEmail, expiresAt: currentTime + SESSION_SECONDS * 1000 });
      return lighthouseSessionCookie(token, SESSION_SECONDS);
    },
  };
}
