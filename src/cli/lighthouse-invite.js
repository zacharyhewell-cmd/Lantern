import { createLighthouseSetupLink } from "../lighthouse/invite.js";

try {
  const [email, pageUrl] = process.argv.slice(2);
  console.log(createLighthouseSetupLink(email, pageUrl, process.env.LIGHTHOUSE_SETUP_SECRET));
} catch (error) {
  console.error(`Could not create setup link: ${error.message}`);
  console.error("Usage: node src/cli/lighthouse-invite.js APPROVED_EMAIL https://YOUR_HOST/lighthouse");
  process.exitCode = 1;
}
