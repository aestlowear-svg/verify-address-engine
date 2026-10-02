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
      "https://my.ithinklogistics.com/api_v3/store/get-order-list.json",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        body: JSON.stringify({
          data: {
            platform_id: 2,
            start_date: "2026-10-01",
            end_date: "2026-10-02",
            access_token: accessToken,
            secret_key: secretKey,
          },
        }),
      }
    );

    const data = await response.json();

    return NextResponse.json({
      ok: response.ok,
      httpStatus: response.status,
      ithinkStatus: data.status ?? null,
      statusCode: data.status_code ?? null,
      orders: data.data ?? null,
    });
  } catch (error) {
    console.error("iThink order list error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
