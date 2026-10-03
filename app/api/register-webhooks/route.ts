import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const setupKey =
      new URL(request.url).searchParams.get("key");

    const internalSecret =
      process.env.INTERNAL_PROCESSOR_SECRET;

    if (
      !internalSecret ||
      setupKey !== internalSecret
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const shop =
      process.env.SHOPIFY_SHOP;

    const clientId =
      process.env.SHOPIFY_CLIENT_ID;

    const clientSecret =
      process.env.SHOPIFY_CLIENT_SECRET;

    if (
      !shop ||
      !clientId ||
      !clientSecret
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Shopify environment variables are missing",
        },
        { status: 500 }
      );
    }

    /*
     * Get Shopify access token
     */

    const tokenResponse = await fetch(
      `https://${shop}.myshopify.com/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type:
            "client_credentials",
          client_id:
            clientId,
          client_secret:
            clientSecret,
        }).toString(),
      }
    );

    const tokenData =
      await tokenResponse.json();

    if (
      !tokenResponse.ok ||
      !tokenData.access_token
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Could not authenticate with Shopify",
        },
        { status: 500 }
      );
    }

    const accessToken =
      tokenData.access_token;

    const webhookUrl =
      "https://verify-address-engine.vercel.app/api/webhooks/shopify";

    const mutation = `
      mutation CreateWebhook(
        $topic: WebhookSubscriptionTopic!,
        $webhookSubscription: WebhookSubscriptionInput!
      ) {
        webhookSubscriptionCreate(
          topic: $topic
          webhookSubscription: $webhookSubscription
        ) {
          webhookSubscription {
            id
            topic
            uri
          }

          userErrors {
            field
            message
          }
        }
      }
    `;

    const topics = [
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
    ];

    const results = [];

    for (const topic of topics) {
      const response = await fetch(
        `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            "X-Shopify-Access-Token":
              accessToken,
          },
          body: JSON.stringify({
            query: mutation,
            variables: {
              topic,
              webhookSubscription: {
                uri: webhookUrl,
              },
            },
          }),
        }
      );

      const data =
        await response.json();

      results.push({
        topic,
        data,
      });
    }

    return NextResponse.json({
      ok: true,
      webhookUrl,
      results,
    });
  } catch (error) {
    console.error(
      "Webhook registration error:",
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Internal server error",
      },
      { status: 500 }
    );
  }
}
