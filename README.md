# Lantern

Lantern answers Feishu requests that begin with `Lantern` and an order number, then returns order tracking information in a threaded reply.

## Current Scope

- Trigger: messages that begin with `Lantern`, case-insensitive
- Message format: `Lantern 29690` or `Lantern WS-#29690`
- Channel: Feishu test group `Lantern`
- Request type: order tracking
- Data source priority:
  - Surpath is the primary shipment/WMS source.
  - Surpath is queried directly by WS order number when `customerPlatformCode` is available.
  - Shopify enriches Surpath data and remains a fallback bridge for older orders that are not directly searchable in Surpath.
  - FedEx is authoritative for parcel `In Transit` and `Delivered` movement.
- Reply style: threaded Feishu reply

## Local Shopify Lookup

Set the Shopify credentials in your shell or in a local `.env` file that is not committed:

```bash
export SHOPIFY_SHOP_DOMAIN="velotric-dealers-shop.myshopify.com"
export SHOPIFY_CLIENT_ID="..."
export SHOPIFY_CLIENT_SECRET="..."
```

Then run:

```bash
npm run lookup -- "WS-#12345"
```

The lookup prints Lantern's normalized response text, not raw Shopify data.

## One-Shot Feishu Listener

For local testing, run:

```bash
export FEISHU_LANTERN_CHAT_ID="oc_e7d5c76b3623d0f7f3809309861d5b54"
export SURPATH_MCP_URL="..."
npm run listen-once
```

This waits for one matching Feishu message, builds a Surpath-first tracking reply, replies in-thread, then exits.

## Local Listener

To keep Lantern listening on this machine:

```bash
npm run light
```

To stop the local listener:

```bash
npm run extinguish
```

The local control commands keep one PID file at `var/lantern-listener.pid` and append logs to `var/lantern-listener.log`.

For standalone deployment, set `SURPATH_MCP_URL` directly in the service environment. The local prototype can read the same URL from Codex's MCP config when that variable is missing, but that fallback is only for development on this machine.

## Hosted Webhook Service

Lantern can also run as a small web service. This is the path for moving it off this machine.

Local smoke test:

```bash
FEISHU_APP_ID=dummy FEISHU_APP_SECRET=dummy npm start
```

Then open:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"ok":true,"service":"lantern"}
```

The Feishu event callback path is:

```text
/feishu/events
```

On Render, the full callback URL will look like:

```text
https://<render-service-name>.onrender.com/feishu/events
```

### Render Setup

Use `render.yaml` as the service blueprint, or create the same service manually:

- Service type: Web Service
- Runtime: Node
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Instance size: the smallest paid web service is enough for this workload

Required environment values:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_LANTERN_CHAT_ID`
- `FEISHU_ALLOWED_CHAT_IDS`, optional comma-separated additional Feishu groups
- `SURPATH_MCP_URL`
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, or `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `FEDEX_CLIENT_ID`
- `FEDEX_CLIENT_SECRET`

Optional environment values:

- `FEISHU_WEBHOOK_PATH`, default `/feishu/events`
- `FEISHU_API_BASE_URL`, default `https://open.feishu.cn`
- `SHOPIFY_API_VERSION`, default `2026-01`
- `FEDEX_API_BASE_URL`, default `https://apis.fedex.com`

Watchtower environment values:

- `WATCHTOWER_RUN_SECRET`, required for hosted Watchtower runs; use a long random value
- `WATCHTOWER_FEISHU_CHAT_ID`, Feishu chat ID for the report destination, for example `US Logistics Team`
- `WATCHTOWER_RUN_PATH`, default `/watchtower/run`
- `WATCHTOWER_CREATE_TIME_LOOKBACK_DAYS`, default `30`
- `WATCHTOWER_PRESHIP_THRESHOLD_HOURS`, default `48`
- `WATCHTOWER_IN_TRANSIT_THRESHOLD_HOURS`, default `120`
- `WATCHTOWER_OUTPUT_DIR`, default `outputs/watchtower`
- `WATCHTOWER_SCHEDULE_ENABLED`, set to `true` to run Watchtower automatically from the hosted Lantern service
- `WATCHTOWER_SCHEDULE_TIME_ZONE`, default `America/Los_Angeles`
- `WATCHTOWER_SCHEDULE_HOUR`, default `22`
- `WATCHTOWER_SCHEDULE_MINUTE`, default `30`

The hosted Watchtower endpoint is:

```text
POST /watchtower/run
Authorization: Bearer <WATCHTOWER_RUN_SECRET>
```

When called, Lantern scans Surpath, creates the Watchtower workbook, posts a short summary to `WATCHTOWER_FEISHU_CHAT_ID`, and uploads the `.xlsx` report as a Feishu file message.

For the simplest hosted schedule, set `WATCHTOWER_SCHEDULE_ENABLED=true` on Render. The web service checks once per minute and runs Watchtower Monday-Friday at 10:30 PM Pacific by default.

To request a manual refresh from Feishu, post this exact phrase in an allowed bot channel:

```text
Watchtower refresh
```

Lantern replies in-thread to acknowledge the refresh, then reposts the report to `WATCHTOWER_FEISHU_CHAT_ID` when the workbook is ready. The `WATCHTOWER_FEISHU_CHAT_ID` channel is automatically treated as an allowed Watchtower trigger channel.

You can also use an external scheduler that sends an authenticated `POST` request to:

```text
https://<render-service-name>.onrender.com/watchtower/run
```

Set any external schedule to Monday-Friday at 10:30 PM America/Los_Angeles. The endpoint itself is protected by `WATCHTOWER_RUN_SECRET`; do not put that value in chat or committed files.

### Feishu App Setup

For the first hosted deployment:

- Set the app/bot name and avatar in the Feishu developer console.
- Enable the `im.message.receive_v1` event.
- Grant the bot permission to read group messages and reply/send messages.
- Add the bot to the private Lantern test group.
- Set the event callback URL to the Render URL plus `/feishu/events`.
- Use the verification token value from Feishu as `FEISHU_VERIFICATION_TOKEN`.

Leave encrypted callbacks disabled for the first cut unless we add decrypt support. The current webhook validates Feishu's verification token and handles URL verification, but it does not decrypt encrypted event payloads.

### Cutover Plan

1. Keep the local `Light` listener available while deploying the hosted service.
2. Deploy Lantern to Render and confirm `/health`.
3. Configure Feishu to point events at the Render callback URL.
4. Test in the private Lantern group.
5. When hosted replies are reliable, run `npm run extinguish` locally and leave Render as the only listener.
