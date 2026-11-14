import { issueLighthouseSetupToken } from "./accounts.js";

export function createLighthouseSetupLink(email, pageUrl, setupSecret) {
  const url = new URL(pageUrl);
  if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "/lighthouse" ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("Use the HTTPS Lighthouse page URL.");
  }
  const token = issueLighthouseSetupToken(email, setupSecret);
  url.hash = new URLSearchParams({ setup: token }).toString();
  return url.href;
}
