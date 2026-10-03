import { NextResponse } from "next/server";

export async function GET() {
  try {
    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
      return NextResponse.json(
        {
          ok: false,
          error: "Shopify environment variables are missing",
        },
        { status: 500 }
      );
    }

    // Get Shopify access token
    const tokenResponse = await fetch(
      `https://${shop}.myshopify.com/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Shopify authentication error:", tokenData);

      return NextResponse.json(
        {
          ok: false,
          error: "Could not authenticate with Shopify",
        },
        { status: 500 }
      );
    }

    const accessToken = tokenData.access_token;

    const query = `
      query {
        orders(
          first: 20,
          sortKey: CREATED_AT,
          reverse: true
        ) {
          nodes {
            id
            name
            createdAt

            displayFinancialStatus
            displayFulfillmentStatus

            shippingAddress {
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }

            billingAddress {
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }

            tags
          }
        }
      }
    `;

    const shopifyResponse = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      }
    );

    const shopifyData = await shopifyResponse.json();

    if (!shopifyResponse.ok || shopifyData.errors) {
      console.error("Shopify GraphQL error:", shopifyData);

      return NextResponse.json(
        {
          ok: false,
          error: "Shopify GraphQL request failed",
          details: shopifyData.errors || shopifyData,
        },
        { status: 500 }
      );
    }

    const orders = shopifyData.data?.orders?.nodes || [];

    return NextResponse.json({
      ok: true,
      shop: `${shop}.myshopify.com`,
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("Shopify orders error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
