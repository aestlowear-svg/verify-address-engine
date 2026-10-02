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

    const candidates = [
      "11154672156966",
      "11154820333862",
      "1115538659814",
      "11156903133478",
    ];

    const results = [];

    for (const orderNo of candidates) {
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
              order_no_list: orderNo,
              platform_id: 2,
              access_token: accessToken,
              secret_key: secretKey,
            },
          }),
        }
      );

      const data = await response.json();

      const order = data?.data?.[orderNo] ?? null;

      results.push({
        tested: orderNo,
        httpStatus: response.status,
        ithinkStatus: data.status ?? null,
        orderNumber: order?.order_number ?? null,
        orderId: order?.order_id ?? null,
        orderDate: order?.order_date ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      results,
    });
  } catch (error) {
    console.error("iThink diagnostic error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
