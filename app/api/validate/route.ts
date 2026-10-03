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

    /*
     * Send the original customer shipping address to Google.
     * Google performs the actual address validation,
     * formatting, correction and geographic processing.
     */
    const googleResponse = await fetch(
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

    const googleData = await googleResponse.json();

    if (!googleResponse.ok) {
      console.error("Google Address Validation error:", googleData);

      return NextResponse.json(
        {
          ok: false,
          decision: "ISSUE",
          originalAddress: address,
          error: "Google Address Validation request failed",
          details: googleData,
        },
        { status: googleResponse.status }
      );
    }

    const result = googleData.result || null;
    const verdict = result?.verdict || null;
    const validatedAddress = result?.address || null;
    const geocode = result?.geocode || null;

    const formattedAddress =
      validatedAddress?.formattedAddress || null;

    const possibleNextAction =
      verdict?.possibleNextAction || null;

    const addressComplete =
      verdict?.addressComplete === true;

    const validationGranularity =
      verdict?.validationGranularity || null;

    const geocodeGranularity =
      verdict?.geocodeGranularity || null;

    /*
     * Conservative production rule:
     *
     * We only allow an automatic Shopify update when:
     *
     * 1. Google says ACCEPT
     * 2. Google says the address is complete
     * 3. Google returned a formatted address
     * 4. Google returned a geographic result
     *
     * We do NOT invent missing information ourselves.
     */
    const safeToUpdate =
      possibleNextAction === "ACCEPT" &&
      addressComplete === true &&
      !!formattedAddress &&
      !!geocode?.location;

    return NextResponse.json({
      ok: true,

      decision: safeToUpdate ? "ACCEPT" : "ISSUE",

      originalAddress: address,

      finalAddress: safeToUpdate ? formattedAddress : null,

      google: {
        possibleNextAction,
        addressComplete,
        validationGranularity,
        geocodeGranularity,
        formattedAddress,
        location: geocode?.location || null,
        placeId: geocode?.placeId || null,
      },

      result,
      responseId: googleData.responseId || null,
    });
  } catch (error) {
    console.error("Address validation error:", error);

    return NextResponse.json(
      {
        ok: false,
        decision: "ISSUE",
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
