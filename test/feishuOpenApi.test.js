import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("sends markdown tracking links as Feishu rich text", async () => {
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

  await client.replyInThread("om_root", "Tracking: [123](https://example.com/123)", { idempotencyKey: "evt-2" });

  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.msg_type, "post");
  assert.equal(body.reply_in_thread, true);
  assert.equal(body.uuid, "evt-2");
  assert.deepEqual(JSON.parse(body.content).en_us.content, [[
    { tag: "text", text: "Tracking: " },
    { tag: "a", text: "123", href: "https://example.com/123" },
  ]]);
});

test("normalizes long or invalid Feishu message UUID values", async () => {
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

  await client.replyInThread("om_root", "hello", {
    idempotencyKey: `${"evt".repeat(40)}!`,
  });

  const body = JSON.parse(requests[1].options.body);
  assert.match(body.uuid, /^lantern-[a-f0-9]{32}$/);
  assert.ok(body.uuid.length <= 64);
});

test("uploads and sends a Feishu file message", async () => {
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

    if (url.endsWith("/open-apis/im/v1/files")) {
      return {
        ok: true,
        async json() {
          return { code: 0, data: { file_key: "file_key_1" } };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return { code: 0, data: { message_id: "om_file" } };
      },
    };
  };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lantern-feishu-"));
  const filePath = path.join(dir, "report.xlsx");
  await fs.writeFile(filePath, "report");

  const client = new FeishuOpenApiClient({
    apiBaseUrl: "https://open.feishu.test",
    appId: "app-id",
    appSecret: "app-secret",
  }, fetchImpl);

  const result = await client.sendFileMessage("oc_chat", filePath, { idempotencyKey: "file-1" });

  assert.equal(result.fileKey, "file_key_1");
  assert.equal(requests[1].url, "https://open.feishu.test/open-apis/im/v1/files");
  assert.equal(requests[1].options.headers.Authorization, "Bearer tenant-token");
  assert.equal(requests[2].url, "https://open.feishu.test/open-apis/im/v1/messages?receive_id_type=chat_id");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    content: "{\"file_key\":\"file_key_1\"}",
    msg_type: "file",
    receive_id: "oc_chat",
    uuid: "file-1",
  });
});

test("reads and writes Feishu Sheet ranges", async () => {
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
        return { code: 0, data: {} };
      },
    };
  };

  const client = new FeishuOpenApiClient({
    apiBaseUrl: "https://open.feishu.test",
    appId: "app-id",
    appSecret: "app-secret",
  }, fetchImpl);

  await client.getSpreadsheet("sht_test");
  await client.writeSheetRange("sht_test", "sheet1!A1:B2", [["A", "B"]]);
  await client.readSheetRange("sht_test", "sheet1!A1:B2");
  await client.batchUpdateSheets("sht_test", [{ addSheet: { properties: { title: "Tab" } } }]);
  await client.setSheetDropdown("sht_test", "sheet1!C2:C100", ["TRUE", "FALSE"]);
  await client.setSheetStyle("sht_test", "sheet1!A1:C1", { font: { bold: true } });

  assert.equal(requests[1].url, "https://open.feishu.test/open-apis/sheets/v3/spreadsheets/sht_test");
  assert.equal(requests[2].url, "https://open.feishu.test/open-apis/sheets/v2/spreadsheets/sht_test/values");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    valueRange: {
      range: "sheet1!A1:B2",
      values: [["A", "B"]],
    },
  });
  assert.equal(requests[3].url, "https://open.feishu.test/open-apis/sheets/v2/spreadsheets/sht_test/values/sheet1!A1%3AB2");
  assert.equal(requests[4].url, "https://open.feishu.test/open-apis/sheets/v2/spreadsheets/sht_test/sheets_batch_update");
  assert.equal(requests[5].url, "https://open.feishu.test/open-apis/sheets/v2/spreadsheets/sht_test/dataValidation");
  assert.equal(requests[6].url, "https://open.feishu.test/open-apis/sheets/v2/spreadsheets/sht_test/style");
});
