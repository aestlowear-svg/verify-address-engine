import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const address = body.address;

    if (!address || typeof address !== "string") {
      return NextResponse.json(
        {
          ok: false,
          error: "address is required",
        },
        { status: 400 }
      );
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "GOOGLE_MAPS_API_KEY is not configured",
        },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          address: {
            regionCode: "IN",
            addressLines: [address],
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Google Address Validation error:", data);

      return NextResponse.json(
        {
          ok: false,
          error: "Google Address Validation request failed",
          details: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,
      originalAddress: address,
      result: data.result || null,
      responseId: data.responseId || null,
    });
  } catch (error) {
    console.error("Address validation error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
