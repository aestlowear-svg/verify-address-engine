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

    const orderNo = "11154820333862";

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

    return NextResponse.json({
      ok: response.ok,
      tested: orderNo,
      httpStatus: response.status,
      ithinkStatus: data.status ?? null,
      statusCode: data.status_code ?? null,
      response: data,
    });
  } catch (error) {
    console.error("iThink order details error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
