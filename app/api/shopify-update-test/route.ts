import { NextResponse } from "next/server";

type AddressInput = {
  address1: string;
  address2?: string;
  city: string;
  province: string;
  provinceCode?: string;
  zip: string;
  country: string;
  countryCode?: string;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const orderId = body.orderId;
    const address = body.address as AddressInput;

    if (!orderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "orderId is required",
        },
        { status: 400 }
      );
    }

    if (!address?.address1 || !address?.city || !address?.zip) {
      return NextResponse.json(
        {
          ok: false,
          error: "address.address1, city and zip are required",
        },
        { status: 400 }
      );
    }

    const shop = process.env.SHOPIFY_SHOP;
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!shop || !clientId || !clientSecret) {
      return NextResponse.json(
        {
          ok: false,
          error: "Shopify environment variables are missing",
          hasShop: !!shop,
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret,
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

    /*
     * IMPORTANT:
     * We update ONLY the SHIPPING address.
     *
     * We do NOT send billingAddress.
     * We do NOT send tags.
     * Existing Shopify tags and billing information are therefore
     * not intentionally modified by this mutation.
     */

    const mutation = `
      mutation UpdateOrder($input: OrderInput!) {
        orderUpdate(input: $input) {
          order {
            id
            name

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

          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        id: orderId,

        shippingAddress: {
          address1: address.address1,
          address2: address.address2 || null,
          city: address.city,
          province: address.province,
          provinceCode: address.provinceCode || null,
          zip: address.zip,
          country: address.country,
          countryCode: address.countryCode || "IN",
        },
      },
    };

    const shopifyResponse = await fetch(
      `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables,
        }),
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

    const result = shopifyData.data?.orderUpdate;

    if (!result) {
      return NextResponse.json(
        {
          ok: false,
          error: "Shopify did not return an orderUpdate result",
        },
        { status: 500 }
      );
    }

    if (result.userErrors?.length) {
      return NextResponse.json(
        {
          ok: false,
          error: "Shopify rejected the address update",
          userErrors: result.userErrors,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      updated: true,
      order: result.order,
    });
  } catch (error) {
    console.error("Shopify update test error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
