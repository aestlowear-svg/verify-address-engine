import { NextResponse } from "next/server";

export async function GET() {
  try {
    const accessToken = process.env.ITHINK_ACCESS_TOKEN;
    const secretKey = process.env.ITHINK_SECRET_KEY;

    if (!accessToken || !secretKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "iThink credentials are not configured",
        },
        { status: 500 }
      );
    }

    const response = await fetch(
      "https://my.ithinklogistics.com/api_v3/store/get-order-details.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify({
          data: {
            order_no_list: "4623",
            platform_id: 2,
            access_token: accessToken,
            secret_key: secretKey,
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "iThink API request failed",
          status: response.status,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,

      // Only expose the fields we actually need for testing.
      ithinkStatus: data.status ?? null,

      order: data.data?.["4623"]
        ? {
            orderNumber: data.data["4623"].order_number ?? null,
            customerAddress1:
              data.data["4623"].customer_address1 ?? null,
            customerAddress2:
              data.data["4623"].customer_address2 ?? null,
            city: data.data["4623"].customer_city ?? null,
            state: data.data["4623"].customer_state ?? null,
            pincode: data.data["4623"].customer_pincode ?? null,
          }
        : null,

      rawStatusCode: data.status_code ?? null,
    });
  } catch (error) {
    console.error("iThink test error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
