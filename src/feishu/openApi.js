function compact(value) {
  return value == null || value === "" ? null : value;
}

function assertConfigured(config) {
  if (!config?.appId || !config?.appSecret) {
    throw new Error("Missing Feishu app credentials");
  }
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

  async replyInThread(messageId, text, { idempotencyKey } = {}) {
    const token = await this.getTenantAccessToken();
    const body = {
      content: JSON.stringify({ text }),
      msg_type: "text",
      reply_in_thread: true,
    };
    const uuid = compact(idempotencyKey);
    if (uuid) {
      body.uuid = uuid;
    }

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
      throw new Error(`Feishu reply failed: ${result.msg || result.message || response.status}`);
    }

    return result;
  }
}
