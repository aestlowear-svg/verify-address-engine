import { NextResponse } from "next/server";
import crypto from "crypto";

function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string,
  secret: string
): boolean {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const digestBuffer =
    Buffer.from(digest, "utf8");

  const hmacBuffer =
    Buffer.from(hmacHeader, "utf8");

  if (
    digestBuffer.length !==
    hmacBuffer.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    digestBuffer,
    hmacBuffer
  );
}

export async function POST(
  request: Request
) {
  try {
    /*
     * ==================================================
     * 1. READ RAW SHOPIFY WEBHOOK
     * ==================================================
     *
     * IMPORTANT:
     * HMAC must be calculated from the raw request body.
     */

    const rawBody =
      await request.text();

    const hmac =
      request.headers.get(
        "x-shopify-hmac-sha256"
      );

    const shop =
      request.headers.get(
        "x-shopify-shop-domain"
      );

    const topic =
      request.headers.get(
        "x-shopify-topic"
      );

    const webhookId =
      request.headers.get(
        "x-shopify-webhook-id"
      );

    if (
      !hmac ||
      !shop ||
      !topic
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Missing Shopify webhook headers",
        },
        { status: 400 }
      );
    }

    /*
     * ==================================================
     * 2. VERIFY SHOP
     * ==================================================
     */

    const expectedShop =
      `${process.env.SHOPIFY_SHOP}.myshopify.com`;

    if (
      shop !== expectedShop
    ) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid Shopify shop",
        },
        { status: 401 }
      );
    }

    /*
     * ==================================================
     * 3. VERIFY SHOPIFY HMAC
     * ==================================================
     */

    const clientSecret =
      process.env.SHOPIFY_CLIENT_SECRET;

    if (!clientSecret) {
      console.error(
        "SHOPIFY_CLIENT_SECRET is missing"
      );

      return NextResponse.json(
        {
          ok: false,
          error:
            "Shopify client secret is not configured",
        },
        { status: 500 }
      );
    }

    const validHmac =
      verifyShopifyHmac(
        rawBody,
        hmac,
        clientSecret
      );

    if (!validHmac) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid Shopify webhook signature",
        },
        { status: 401 }
      );
    }

    /*
     * ==================================================
     * 4. ONLY PROCESS ORDER WEBHOOKS
     * ==================================================
     */

    const allowedTopics = [
      "orders/create",
      "orders/updated",
    ];

    if (
      !allowedTopics.includes(topic)
    ) {
      return NextResponse.json({
        ok: true,
        received: true,
        ignored: true,
        reason:
          "TOPIC_NOT_USED",
        topic,
      });
    }

    /*
     * ==================================================
     * 5. READ PAYLOAD
     * ==================================================
     */

    let payload: any;

    try {
      payload =
        JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Invalid JSON payload",
        },
        { status: 400 }
      );
    }

    /*
     * ==================================================
     * 6. GET SHOPIFY ORDER ID
     * ==================================================
     *
     * Shopify webhook payloads normally include
     * admin_graphql_api_id.
     *
     * We prefer that because our processor uses
     * Shopify GraphQL IDs.
     */

    const orderId =
      payload?.admin_graphql_api_id ||
      (
        payload?.id
          ? `gid://shopify/Order/${payload.id}`
          : null
      );

    if (!orderId) {
      console.error(
        "Shopify webhook has no order ID",
        {
          topic,
          webhookId,
        }
      );

      return NextResponse.json(
        {
          ok: false,
          error:
            "Order ID not found in webhook",
        },
        { status: 400 }
      );
    }

    /*
     * ==================================================
     * 7. INTERNAL PROCESSOR SECRET
     * ==================================================
     */

    const internalSecret =
      process.env.INTERNAL_PROCESSOR_SECRET;

    if (!internalSecret) {
      console.error(
        "INTERNAL_PROCESSOR_SECRET is missing"
      );

      return NextResponse.json(
        {
          ok: false,
          error:
            "Internal processor secret is not configured",
        },
        { status: 500 }
      );
    }

    /*
     * ==================================================
     * 8. CALL ADDRESS PROCESSOR
     * ==================================================
     */

    const processorUrl =
      new URL(
        "/api/shopify-process-test",
        request.url
      ).toString();

    const processorResponse =
      await fetch(
        processorUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-internal-processor-secret":
              internalSecret,
          },

          body: JSON.stringify({
            orderId,
          }),
        }
      );

    const processorData =
      await processorResponse.json();

    /*
     * ==================================================
     * 9. LOG RESULT
     * ==================================================
     */

    console.log(
      "Shopify address webhook processed:",
      {
        topic,
        shop,
        webhookId,
        orderId,
        processorStatus:
          processorResponse.status,
        decision:
          processorData?.decision,
        reason:
          processorData?.reason,
      }
    );

    /*
     * ==================================================
     * 10. RETURN SUCCESS TO SHOPIFY
     * ==================================================
     */

    return NextResponse.json({
      ok: true,
      received: true,

      topic,
      shop,
      webhookId,

      orderId,

      processor: {
        status:
          processorResponse.status,

        decision:
          processorData?.decision ||
          null,

        reason:
          processorData?.reason ||
          null,
      },
    });
  } catch (error) {
    console.error(
      "Shopify webhook error:",
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}
