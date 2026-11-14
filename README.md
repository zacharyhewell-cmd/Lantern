# Lantern

Lantern answers Feishu requests that begin with `Lantern` and an order number, then returns order tracking information in a threaded reply.

## Lighthouse development preview

Lighthouse is a separate browser presentation of Lantern's structured order-tracking lookup. It has its own public response allowlist and frontend, so Lighthouse display changes do not change Lantern's Feishu replies.

Set `LIGHTHOUSE_UI_USERNAME` and `LIGHTHOUSE_UI_PASSWORD`, start the service, and open `/lighthouse`. The shared preview gate controls access to the page. Customers then sign in using the email on their Shopify orders and a separate password they set in Lighthouse. Lighthouse uses Shopify only for order lookups.

Set `LIGHTHOUSE_ACCOUNTS_DIRECTORY` to an absolute directory on persistent storage (for example, `/var/data/lighthouse-accounts` on a Render disk mounted at `/var/data`). Set `LIGHTHOUSE_SETUP_SECRET` to a randomly generated secret of at least 32 bytes. The existing Shopify Admin API connection needs `read_orders` and access to the protected order email field; it does not need customer login access.

After verifying the customer's email, run this from a trusted shell with the same setup secret and send the resulting link only to the approved address:

```sh
node src/cli/lighthouse-invite.js approved@example.com https://YOUR_HOST/lighthouse
```

The link is valid for 24 hours and can be used once. Customers choose their own password; Lighthouse stores only a salted password hash. Use the same workflow for a reset. Completing a reset invalidates that customer's current sessions.

To issue links in Feishu, enable `im:message.p2p_msg:readonly` for the Lantern bot if needed and publish the Feishu app update. The bot uses its existing `im.message.receive_v1` webhook, which must have `FEISHU_VERIFICATION_TOKEN` configured. Render supplies the default Lighthouse URL. Set `LIGHTHOUSE_PAGE_URL` to override it with the HTTPS Lighthouse page.

Anyone who can DM the Lantern bot can use `Lighthouse invite dealer@example.com` after verifying the customer's email. The bot replies in the same DM with a single-use setup or password reset link. Share the link privately with the intended recipient.

`POST /lighthouse/lookup` requires a session, an order number, and the shipping postal code. It matches the session email against the exact Shopify order's email before shipment enrichment. Missing orders, orders owned by another email, and postal code mismatches return the same generic response. Shopify supplies the shipment and item list; Surpath can supplement a shipment when its tracking number and destination match. Lantern's internal lookup is unchanged.

`LIGHTHOUSE_PUBLIC_ENABLED` defaults to `false`. Setting it to `true` removes the shared preview gate only; customer sign-in and order verification still apply. Responses are not cached and use restrictive browser security headers. Lookups are throttled per customer (`LIGHTHOUSE_RATE_LIMIT_MAX` defaults to 10 per `LIGHTHOUSE_RATE_LIMIT_WINDOW_MS`, which defaults to 60000 milliseconds). Sign-in is also throttled. Sessions last 30 minutes and are lost on restart. The account store, sessions, and rate limits assume a single service instance.

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

### DV1 live planning data

The Lantern service also exposes a protected read-only data gateway for DV1. It reuses the existing Shopify credentials, Surpath MCP connection, and retry behavior, then returns normalized order lines plus Surpath inventory and warehouse locations. It does not split orders, change shipping channels, or mutate either system.

Clients of the data gateway authenticate with `DV1_DATA_API_SECRET`. Lantern’s hosted DV1 planning screen calls the same data loader in-process. The endpoint is:

```text
POST /dv1/data
Authorization: Bearer <DV1_DATA_API_SECRET>
{"orderNumber":"WS-#12345"}
```

The gateway calls Surpath's `querySkuInventory` tool for the order SKUs and configured carton SKUs. `DV1_DEFAULT_WAREHOUSE` and `DV1_CARTON_SKUS` control the planning defaults without changing Lantern's tracking behavior.

The same Lantern service can serve the DV1 operator screen at `/dv1`. Set `DV1_UI_USERNAME` and `DV1_UI_PASSWORD` to enable the protected browser route. The screen is read-only: it runs the recommendation and does not edit Shopify, Eccang, or Surpath.

DV1 known solutions are durably archived in the Feishu sheet `Delineator DV1 Known Solutions`. Lantern reuses its existing `FEISHU_APP_ID` and `FEISHU_APP_SECRET` credentials, hydrates the archive at startup, flushes new records hourly, retries failed syncs, and attempts a final flush during shutdown. Set `DV1_FEISHU_SPREADSHEET_TOKEN` and `DV1_FEISHU_SHEET_ID` to enable the archive.

DV1 refreshes its Feishu catalog and solo-cost inputs together when `DV1_SOURCE_REFRESH_ENABLED=true`. Render enables this on startup and every 168 hours. The updater validates dimensions, duplicate definitions, representative SKUs, all seven carton definitions, and retained SKU coverage in each source before atomically publishing `var/dv1/source-snapshot.json`. Set `DV1_SOURCE_REFRESH_MIN_COVERAGE` to a fraction greater than zero and at most one. It defaults to `0.8`. The first refresh compares against the checked-in catalog and cost files, then subsequent refreshes compare against the active snapshot.

Set `DV1_SOURCE_REFRESH_ALERT_CHAT_ID` to a Feishu chat that the Lantern app can message. A rejected candidate sends one summary to that chat and leaves the active snapshot unchanged. With no chat configured, rejections are logged. Refresh and alert-delivery failures are logged separately. A service instance without a saved runtime snapshot uses the checked-in baselines.

### Developing and deploying DV1

The portable TypeScript optimizer lives in [packages/delineator](packages/delineator/README.md). Lantern owns the DV1 UI, integrations, and planning data in `src/dv1` and `public/dv1`. Both the hosted route and the local fixture runner call the same planning code and read the same checked-in baseline data. The Feishu refresh can supply newer inputs while a service is running.

```bash
npm ci --include=dev
npm test
npm run plan:dv1
```

To plan with your own normalized inputs, use `npm run plan:dv1 -- path/to/order.json path/to/inventory.json`. The fixture runner uses an in-memory solution store.

Commit DV1 changes in this repository. When publishing DV1, push Lantern’s `main` branch to `origin`; Render auto-deploys from that branch and builds the optimizer from the same commit. Verify the deployed commit and `/health` after a push.

Local server smoke test:

```bash
npm run build
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
- Build command: `npm ci --include=dev && npm run build`
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

DV1 known-solution archive values:

- `DV1_FEISHU_SPREADSHEET_TOKEN`, `Rr4wsjvP3hgO5btcCHDcBHqGnRh`
- `DV1_FEISHU_SHEET_ID`, `10dea2`
- `DV1_FEISHU_SYNC_INTERVAL_MS`, default `3600000`

WTF sheet lookup environment values:

- `WTF_SHEET_URL`, optional Feishu Sheet URL for the temporary `WTF WS-#xxxxx` lookup
- `WTF_SHEET_TOKEN`, optional Sheet token; not needed if `WTF_SHEET_URL` is set
- `WTF_SHEET_TITLE`, optional tab title; default `OOS Pending Orders All Products`
- `WTF_SHEET_ID`, optional fallback tab ID; avoid setting this for auto-recreated tabs
- `WTF_SHEET_MAX_ROWS`, default `5000`

Watchtower environment values:

- `WATCHTOWER_RUN_SECRET`, required for hosted Watchtower runs; use a long random value
- `WATCHTOWER_FEISHU_CHAT_ID`, Feishu chat ID for the report destination, for example `US Logistics Team`
- `WATCHTOWER_SHEET_URL`, optional live Feishu Sheet URL for the shared report
- `WATCHTOWER_SHEET_TOKEN`, optional live Feishu Sheet token; not needed if `WATCHTOWER_SHEET_URL` is set
- `WATCHTOWER_SHEET_TABS`, optional fixed tab IDs for the live Sheet, as `Tab title:sheetId` pairs separated by commas
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

When called, Lantern scans Surpath and updates Watchtower. If `WATCHTOWER_SHEET_URL` or `WATCHTOWER_SHEET_TOKEN` is configured, Lantern updates that live Feishu Sheet and posts its link to `WATCHTOWER_FEISHU_CHAT_ID`. Otherwise, it creates and uploads the `.xlsx` report as a file message.

For the live Sheet path:

- Create a blank Feishu Sheet.
- Share it with the logistics team and the Lantern bot.
- Set `WATCHTOWER_SHEET_URL` in Render to the Sheet URL.
- If Feishu metadata does not expose tabs to Render, set `WATCHTOWER_SHEET_TABS` with the fixed tab IDs.
- Lantern will create and maintain the visible report tabs plus a hidden `_Watchtower Actions` tab.
- The `Action taken?` column uses a live `TRUE/FALSE` selector; checked rows are recorded once per OT per report date on the next refresh.

For the simplest hosted schedule, set `WATCHTOWER_SCHEDULE_ENABLED=true` on Render. The web service checks once per minute and runs Watchtower Monday-Friday at 10:30 PM Pacific by default.

To request a manual refresh from Feishu, post this exact phrase in an allowed bot channel:

```text
Watchtower refresh
```

Lantern replies in-thread to acknowledge the refresh, then reposts the live Sheet link or `.xlsx` report to `WATCHTOWER_FEISHU_CHAT_ID` when the report is ready. The `WATCHTOWER_FEISHU_CHAT_ID` channel is automatically treated as an allowed Watchtower trigger channel.

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
