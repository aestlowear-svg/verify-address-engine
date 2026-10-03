import crypto from "crypto";
import { after, NextResponse } from "next/server";

function verifyShopifyWebhook(
  rawBody: string,
  hmacHeader: string | null,
  secret: string
): boolean {
  if (!hmacHeader) {
    return false;
  }

  const generatedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const receivedBuffer = Buffer.from(hmacHeader, "utf8");
  const generatedBuffer = Buffer.from(generatedHmac, "utf8");

  if (receivedBuffer.length !== generatedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    receivedBuffer,
    generatedBuffer
  );
}

export async function POST(request: Request) {
  try {
    /*
     * IMPORTANT:
     * Read the RAW body first.
     *
     * Shopify HMAC verification must use the raw webhook body.
     */
    const rawBody = await request.text();

    const hmac = request.headers.get(
      "x-shopify-hmac-sha256"
    );

    const shop = request.headers.get(
      "x-shopify-shop-domain"
    );

    const topic = request.headers.get(
      "x-shopify-topic"
    );

    const webhookId = request.headers.get(
      "x-shopify-webhook-id"
    );

    const webhookSecret =
      process.env.SHOPIFY_CLIENT_SECRET;

    if (!webhookSecret) {
      console.error(
        "SHOPIFY_CLIENT_SECRET is not configured"
      );

      return NextResponse.json(
        {
          ok: false,
          error: "Webhook secret is not configured",
        },
        { status: 500 }
      );
    }

    /*
     * 1. Verify HMAC
     */
    const validHmac = verifyShopifyWebhook(
      rawBody,
      hmac,
      webhookSecret
    );

    if (!validHmac) {
      console.error(
        "Invalid Shopify webhook HMAC"
      );

      return NextResponse.json(
        {
          ok: false,
          error: "Invalid webhook signature",
        },
        { status: 401 }
      );
    }

    /*
     * 2. Verify the Shopify shop
     */
    const expectedShop =
      `${process.env.SHOPIFY_SHOP}.myshopify.com`;

    if (!shop || shop !== expectedShop) {
      console.error(
        "Unexpected Shopify shop:",
        shop
      );

      return NextResponse.json(
        {
          ok: false,
          error: "Unexpected Shopify shop",
        },
        { status: 401 }
      );
    }

    /*
     * 3. Only process order creation/update webhooks.
     */
    const allowedTopics = [
      "orders/create",
      "orders/updated",
    ];

    if (
      !topic ||
      !allowedTopics.includes(topic)
    ) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        reason: "TOPIC_NOT_USED",
        topic,
      });
    }

    /*
     * 4. Parse the webhook body.
     */
    let body: any;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid JSON payload",
        },
        { status: 400 }
      );
    }

    /*
     * Shopify order webhook payload normally contains
     * the numeric order ID.
     */
    const numericOrderId =
      body?.id;

    if (!numericOrderId) {
      console.error(
        "Shopify webhook did not contain order ID"
      );

      return NextResponse.json(
        {
          ok: false,
          error: "Order ID missing",
        },
        { status: 400 }
      );
    }

    const orderId =
      `gid://shopify/Order/${numericOrderId}`;

    /*
     * 5. Process AFTER acknowledging Shopify.
     *
     * This keeps the webhook response fast.
     *
     * The processor itself performs all safety checks
     * against the CURRENT Shopify order.
     */
    after(async () => {
      try {
        const baseUrl =
          process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : new URL(request.url).origin;

        const processorSecret =
          process.env.INTERNAL_PROCESSOR_SECRET;

        if (!processorSecret) {
          console.error(
            "INTERNAL_PROCESSOR_SECRET is not configured"
          );

          return;
        }

        const response = await fetch(
          `${baseUrl}/api/shopify-process-test`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "X-Internal-Processor-Secret":
                processorSecret,
            },

            body: JSON.stringify({
              orderId,
              webhookId,
              topic,
            }),
          }
        );

        const result =
          await response.text();

        console.log(
          "Shopify address processor result:",
          {
            orderId,
            webhookId,
            topic,
            status: response.status,
            result,
          }
        );
      } catch (error) {
        console.error(
          "Shopify webhook processor error:",
          error
        );
      }
    });

    /*
     * 6. Acknowledge Shopify immediately.
     */
    return NextResponse.json({
      ok: true,
      received: true,
      queued: true,
      topic,
      webhookId,
      orderId,
    });
  } catch (error) {
    console.error(
      "Shopify webhook error:",
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error: "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}
