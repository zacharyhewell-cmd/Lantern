import test from "node:test";
import assert from "node:assert/strict";
import { FeishuOpenApiClient } from "../src/feishu/openApi.js";

test("requests tenant token and sends threaded text reply", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      return {
        ok: true,
        async json() {
          return { code: 0, tenant_access_token: "tenant-token", expire: 7200 };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return { code: 0, data: { message_id: "om_reply" } };
      },
    };
  };

  const client = new FeishuOpenApiClient({
    apiBaseUrl: "https://open.feishu.test",
    appId: "app-id",
    appSecret: "app-secret",
  }, fetchImpl);

  await client.replyInThread("om_root", "hello", { idempotencyKey: "evt-1" });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://open.feishu.test/open-apis/auth/v3/tenant_access_token/internal");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    app_id: "app-id",
    app_secret: "app-secret",
  });
  assert.equal(requests[1].url, "https://open.feishu.test/open-apis/im/v1/messages/om_root/reply");
  assert.equal(requests[1].options.headers.Authorization, "Bearer tenant-token");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    content: "{\"text\":\"hello\"}",
    msg_type: "text",
    reply_in_thread: true,
    uuid: "evt-1",
  });
});
