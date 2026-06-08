export class FedExClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  async getAccessToken() {
    if (!this.isConfigured()) {
      throw new Error("Missing FedEx client credentials");
    }

    const response = await this.fetch(`${this.config.apiBaseUrl}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });

    const body = await response.json();
    if (!response.ok || !body.access_token) {
      throw new Error(`FedEx token request failed: ${body.errors?.[0]?.message || body.error_description || body.error || response.status}`);
    }

    return body.access_token;
  }

  async trackByTrackingNumber(trackingNumber) {
    const token = await this.getAccessToken();
    const response = await this.fetch(`${this.config.apiBaseUrl}/track/v1/trackingnumbers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-locale": "en_US",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        includeDetailedScans: true,
        trackingInfo: [
          {
            trackingNumberInfo: {
              trackingNumber,
            },
          },
        ],
      }),
    });

    const body = await response.json();
    if (!response.ok || body.errors) {
      throw new Error(`FedEx tracking request failed: ${body.errors?.[0]?.message || response.status}`);
    }

    return body;
  }
}
