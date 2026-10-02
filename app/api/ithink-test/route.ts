import { NextResponse } from "next/server";

async function getOrders(
  startDate: string,
  endDate: string,
  accessToken: string,
  secretKey: string
) {
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
          start_date: startDate,
          end_date: endDate,
          access_token: accessToken,
          secret_key: secretKey,
        },
      }),
    }
  );

  const data = await response.json();

  return {
    httpStatus: response.status,
    status: data.status ?? null,
    statusCode: data.status_code ?? null,
    orders: data.data ?? null,
  };
}

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

    const october1 = await getOrders(
      "2026-10-01",
      "2026-10-01",
      accessToken,
      secretKey
    );

    const october2 = await getOrders(
      "2026-10-02",
      "2026-10-02",
      accessToken,
      secretKey
    );

    return NextResponse.json({
      ok: true,
      october1,
      october2,
    });
  } catch (error) {
    console.error("iThink date diagnostic error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
