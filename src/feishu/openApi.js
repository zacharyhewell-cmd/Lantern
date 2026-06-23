import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

function compact(value) {
  return value == null || value === "" ? null : value;
}

function assertConfigured(config) {
  if (!config?.appId || !config?.appSecret) {
    throw new Error("Missing Feishu app credentials");
  }
}

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g;
const FEISHU_UUID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function safeUuid(value) {
  const text = compact(value);
  if (!text) {
    return null;
  }

  if (FEISHU_UUID_PATTERN.test(text)) {
    return text;
  }

  return `lantern-${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

function parseRichTextLine(line) {
  if (!line) {
    return [{ tag: "text", text: " " }];
  }

  const elements = [];
  let lastIndex = 0;

  for (const match of line.matchAll(MARKDOWN_LINK_PATTERN)) {
    if (match.index > lastIndex) {
      elements.push({ tag: "text", text: line.slice(lastIndex, match.index) });
    }

    elements.push({ tag: "a", text: match[1], href: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    elements.push({ tag: "text", text: line.slice(lastIndex) });
  }

  return elements.length ? elements : [{ tag: "text", text: line }];
}

function buildReplyMessageBody(text) {
  const body = {
    content: JSON.stringify({ text }),
    msg_type: "text",
    reply_in_thread: true,
  };

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  if (MARKDOWN_LINK_PATTERN.test(text)) {
    MARKDOWN_LINK_PATTERN.lastIndex = 0;
    const content = String(text).split("\n").map(parseRichTextLine);
    body.content = JSON.stringify({
      zh_cn: { title: "", content },
      en_us: { title: "", content },
    });
    body.msg_type = "post";
  }
  MARKDOWN_LINK_PATTERN.lastIndex = 0;

  return body;
}

export class FeishuOpenApiClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = {
      apiBaseUrl: "https://open.feishu.cn",
      ...config,
    };
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getTenantAccessToken() {
    assertConfigured(this.config);

    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }

    const response = await this.fetch(`${this.config.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`Feishu token request failed: ${body.msg || body.message || response.status}`);
    }

    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(Number(body.expire || 0) - 60, 60) * 1000;
    return this.token;
  }

  async replyInThread(messageId, text, _options = {}) {
    const token = await this.getTenantAccessToken();
    const body = buildReplyMessageBody(text);

    const response = await this.fetch(
      `${this.config.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`Feishu reply failed: ${result.code || response.status} ${result.msg || result.message || response.status}`);
    }

    return result;
  }

  async sendTextMessage(chatId, text, { idempotencyKey } = {}) {
    const token = await this.getTenantAccessToken();
    const body = {
      content: JSON.stringify({ text }),
      msg_type: "text",
      receive_id: chatId,
    };
    const uuid = safeUuid(idempotencyKey);
    if (uuid) {
      body.uuid = uuid;
    }

    const response = await this.fetch(
      `${this.config.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`Feishu message send failed: ${result.code || response.status} ${result.msg || result.message || response.status}`);
    }

    return result;
  }

  async uploadFile(filePath, { fileType = "stream", fileName = path.basename(filePath) } = {}) {
    const token = await this.getTenantAccessToken();
    const bytes = await fs.readFile(filePath);
    const form = new FormData();
    form.append("file_type", fileType);
    form.append("file_name", fileName);
    form.append("file", new Blob([bytes]), fileName);

    const response = await this.fetch(
      `${this.config.apiBaseUrl}/open-apis/im/v1/files`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: form,
      },
    );
    const result = await response.json();
    const fileKey = result.data?.file_key;
    if (!response.ok || result.code !== 0 || !fileKey) {
      throw new Error(`Feishu file upload failed: ${result.msg || result.message || response.status}`);
    }

    return fileKey;
  }

  async sendFileMessage(chatId, filePath, { fileName = path.basename(filePath), idempotencyKey } = {}) {
    const fileKey = await this.uploadFile(filePath, { fileName });
    const token = await this.getTenantAccessToken();
    const body = {
      content: JSON.stringify({ file_key: fileKey }),
      msg_type: "file",
      receive_id: chatId,
    };
    const uuid = safeUuid(idempotencyKey);
    if (uuid) {
      body.uuid = uuid;
    }

    const response = await this.fetch(
      `${this.config.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`Feishu file message send failed: ${result.code || response.status} ${result.msg || result.message || response.status}`);
    }

    return { ...result, fileKey };
  }

  async requestJson(method, apiPath, { body } = {}) {
    const token = await this.getTenantAccessToken();
    const response = await this.fetch(`${this.config.apiBaseUrl}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) {
      throw new Error(`Feishu API request failed: ${result.msg || result.message || response.status}`);
    }

    return result;
  }

  async getSpreadsheet(spreadsheetToken) {
    return this.requestJson("GET", `/open-apis/sheets/v3/spreadsheets/${encodeURIComponent(spreadsheetToken)}`);
  }

  async batchUpdateSheets(spreadsheetToken, requests) {
    return this.requestJson(
      "POST",
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/sheets_batch_update`,
      { body: { requests } },
    );
  }

  async readSheetRange(spreadsheetToken, range) {
    return this.requestJson(
      "GET",
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(range)}`,
    );
  }

  async writeSheetRange(spreadsheetToken, range, values) {
    return this.requestJson(
      "PUT",
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values`,
      {
        body: {
          valueRange: {
            range,
            values,
          },
        },
      },
    );
  }

  async setSheetDropdown(spreadsheetToken, range, values) {
    return this.requestJson(
      "POST",
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/dataValidation`,
      {
        body: {
          dataValidation: {
            conditionValues: values,
          },
          dataValidationType: "list",
          range,
        },
      },
    );
  }

  async setSheetStyle(spreadsheetToken, range, style) {
    return this.requestJson(
      "PUT",
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/style`,
      {
        body: {
          appendStyle: {
            range,
            style,
          },
        },
      },
    );
  }
}
