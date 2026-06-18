import { buildShopifyOrderSearchQuery } from "../orderIds.js";

const ORDER_TRACKING_QUERY = `#graphql
  query LanternOrderTracking($query: String!) {
    orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        cancelledAt
        closed
        closedAt
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress {
          name
          company
          address1
          address2
          city
          provinceCode
          zip
          countryCode
          phone
        }
        lineItems(first: 250) {
          nodes {
            id
            name
            title
            variantTitle
            sku
            quantity
            currentQuantity
            fulfillableQuantity
          }
        }
        fulfillments(first: 250) {
          id
          name
          status
          createdAt
          updatedAt
          deliveredAt
          estimatedDeliveryAt
          trackingInfo(first: 10) {
            company
            number
            url
          }
          fulfillmentLineItems(first: 50) {
            nodes {
              quantity
              lineItem {
                id
                name
                title
                variantTitle
                sku
              }
            }
          }
        }
      }
    }
  }
`;

export class ShopifyClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async getAccessToken() {
    if (this.config.adminAccessToken) {
      return this.config.adminAccessToken;
    }

    if (!this.config.clientId || !this.config.clientSecret) {
      throw new Error("Missing Shopify client credentials or admin access token");
    }

    const response = await this.fetch(`https://${this.config.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "client_credentials",
      }),
    });

    const body = await response.json();
    if (!response.ok || !body.access_token) {
      throw new Error(`Shopify token request failed: ${body.error_description || body.error || response.status}`);
    }

    return body.access_token;
  }

  async graphql(query, variables) {
    const token = await this.getAccessToken();
    const response = await this.fetch(
      `https://${this.config.shopDomain}/admin/api/${this.config.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    const body = await response.json();
    if (!response.ok || body.errors) {
      throw new Error(`Shopify GraphQL request failed: ${JSON.stringify(body.errors || body)}`);
    }

    return body.data;
  }

  async findOrdersForTracking(orderIdentifier) {
    const query = buildShopifyOrderSearchQuery(orderIdentifier);
    const data = await this.graphql(ORDER_TRACKING_QUERY, { query });
    return data.orders.nodes;
  }
}
