import { issueLighthouseSetupToken } from "../lighthouse/accounts.js";

try {
  const [email, pageUrl] = process.argv.slice(2);
  const url = new URL(pageUrl);
  if (url.protocol !== "https:" || url.pathname.replace(/\/$/, "") !== "/lighthouse" ||
    url.username || url.password || url.search) {
    throw new Error("Use the HTTPS Lighthouse page URL.");
  }
  const token = issueLighthouseSetupToken(email, process.env.LIGHTHOUSE_SETUP_SECRET);
  url.hash = new URLSearchParams({ setup: token }).toString();
  console.log(url.href);
} catch (error) {
  console.error(`Could not create setup link: ${error.message}`);
  console.error("Usage: node src/cli/lighthouse-invite.js APPROVED_EMAIL https://YOUR_HOST/lighthouse");
  process.exitCode = 1;
}
