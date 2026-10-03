import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.text();

    const topic = request.headers.get("x-shopify-topic");
    const shop = request.headers.get("x-shopify-shop-domain");
    const webhookId = request.headers.get("x-shopify-webhook-id");

    console.log("Shopify webhook received:", {
      topic,
      shop,
      webhookId,
    });

    console.log("Webhook body:", body);

    return NextResponse.json({
      ok: true,
      received: true,
      topic,
      shop,
      webhookId,
    });
  } catch (error) {
    console.error("Shopify webhook error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Webhook processing failed",
      },
      { status: 500 }
    );
  }
}
