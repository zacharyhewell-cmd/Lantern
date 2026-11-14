import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLighthouseSessions } from "../src/lighthouse/auth.js";
import { createLighthouseAccounts, issueLighthouseSetupToken } from "../src/lighthouse/accounts.js";
import { lookupOwnedOrderTracking } from "../src/tracking/surpathTracking.js";

test("only an approved email can set a password; setup links expire and cannot be replayed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lighthouse-accounts-"));
  try {
    const setupSecret = "test setup secret, at least 32 bytes";
    const email = "owner@example.com";
    const password = "first long customer password";
    const replacement = "another long customer password";
    let now = 1_000;
    const accounts = createLighthouseAccounts({ directory, setupSecret, now: () => now });
    const token = issueLighthouseSetupToken("Owner@Example.com", setupSecret, now);
    const [payload] = token.split(".");
    assert.equal(await accounts.setPassword({ token: payload + "." + "A".repeat(43), password }), null);
    assert.equal(await accounts.setPassword({ token, password: "short" }), null);
    assert.deepEqual(await accounts.setPassword({ token, password, email: "forged@example.com" }), { email });
    assert.equal(await accounts.setPassword({ token, password: replacement }), null);

    const [file] = await readdir(directory);
    const record = await readFile(join(directory, file), "utf8");
    assert.doesNotMatch(record, /first long customer password|owner@example.com/);
    const restarted = createLighthouseAccounts({ directory, setupSecret, now: () => now });
    assert.deepEqual(await restarted.authenticate({ email, password }), { email });
    assert.equal(await restarted.authenticate({ email, password: replacement }), null);
    assert.equal(await restarted.authenticate({ email: "forged@example.com", password }), null);

    now += 1;
    const reset = issueLighthouseSetupToken(email, setupSecret, now);
    assert.deepEqual(await restarted.setPassword({ token: reset, password: replacement }), { email });
    assert.equal(await restarted.authenticate({ email, password }), null);
    assert.deepEqual(await restarted.authenticate({ email, password: replacement }), { email });
    now += 1;
    const unused = issueLighthouseSetupToken(email, setupSecret, now);
    now += 24 * 60 * 60 * 1000;
    assert.equal(await restarted.setPassword({ token: unused, password }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sessions expire after 30 minutes and password resets can revoke active sessions", () => {
  let now = 1_000;
  const sessions = createLighthouseSessions({ now: () => now });
  const email = "owner@example.com";
  const issue = () => ({ headers: { cookie: sessions.issue({ email }).split(";")[0] } });
  const request = issue();
  assert.equal(sessions.get(request).email, email);
  now += 30 * 60 * 1000;
  assert.equal(sessions.get(request), null);
  const second = issue();
  sessions.revokeEmail(email);
  assert.equal(sessions.get(second), null);
});

test("ownership requires an exact, unique Shopify order and rejects before enrichment", async () => {
  const order = {
    id: "gid://shopify/Order/10",
    name: "WS-#12345",
    email: "Owner@Example.com",
    shippingAddress: { zip: "97214" },
  };
  const input = { orderText: "12345", ownerEmail: "owner@example.com", postalCode: "97214" };
  let orders = [order];
  let enriched = 0;
  const lookup = (options) => lookupOwnedOrderTracking({ ...input, ...options }, {
    loadOrders: async () => orders,
    createSurpathClient: () => assert.fail("Surpath must not be used without an authorized tracking number"),
    enrichWithFedEx: async (summary) => { enriched += 1; return summary; },
  });

  assert.equal(await lookup({ ownerEmail: "other@example.com" }), null);
  assert.equal(await lookup({ postalCode: "00000" }), null);
  orders = [{ ...order, name: "WS-#123456" }];
  assert.equal(await lookup(), null);
  orders = [{ ...order, email: null }];
  assert.equal(await lookup(), null);
  orders = [order, { ...order, name: "#12345" }];
  assert.equal(await lookup(), null);
  assert.equal(enriched, 0);

  orders = [order];
  const summary = await lookup();
  assert.equal(summary.orderId, order.id);
  assert.equal(summary.email, undefined);
  assert.equal(enriched, 1);
});
