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
      return NextResponse.json(
        {
          ok: false,
          error: "Could not authenticate with Shopify",
        },
        { status: 500 }
      );
    }

    const accessToken = tokenData.access_token;

    const webhookUrl =
      "https://verify-address-engine.vercel.app/api/webhooks/shopify";

    const graphqlUrl =
      `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`;

    /*
     * Check existing webhooks first.
     */
    const existingResponse = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `
          query {
            webhookSubscriptions(first: 100) {
              nodes {
                id
                topic
                uri
              }
            }
          }
        `,
      }),
    });

    const existingData = await existingResponse.json();

    if (!existingResponse.ok || existingData.errors) {
      return NextResponse.json(
        {
          ok: false,
          error: "Could not read existing Shopify webhooks",
          details: existingData,
        },
        { status: 500 }
      );
    }

    const existing =
      existingData.data?.webhookSubscriptions?.nodes || [];

    const topics = [
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
    ];

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

    const results = [];

    for (const topic of topics) {
      const alreadyExists = existing.find(
        (webhook: any) =>
          webhook.topic === topic &&
          webhook.uri === webhookUrl
      );

      if (alreadyExists) {
        results.push({
          topic,
          status: "ALREADY_EXISTS",
          id: alreadyExists.id,
          uri: alreadyExists.uri,
        });

        continue;
      }

      const response = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
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
      });

      const data = await response.json();

      results.push({
        topic,
        status: "CREATED",
        data,
      });
    }

    return NextResponse.json({
      ok: true,
      webhookUrl,
      results,
    });
  } catch (error) {
    console.error("Webhook registration error:", error);

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
