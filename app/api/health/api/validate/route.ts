import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const address = body.address;

    if (!address) {
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
          error: "Google Maps API key is not configured",
        },
        { status: 500 }
      );
    }

    const response = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          address: {
            addressLines: [address],
            regionCode: "IN",
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Google Address Validation failed",
          details: data,
        },
        { status: response.status }
      );
    }

    return NextResponse.json({
      ok: true,
      result: data,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid request",
      },
      { status: 400 }
    );
  }
}
