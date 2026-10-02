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

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error: "GEMINI_API_KEY is not configured",
        },
        { status: 500 }
      );
    }

    const prompt = `
You are an Indian e-commerce delivery address specialist.

Your job is to understand the customer's raw delivery address and rewrite it into the clearest, most delivery-friendly version of the SAME intended address.

Use Google Maps grounding to understand and verify the location.

Important instructions:

1. Fix spelling mistakes.
2. Fix punctuation and formatting.
3. Reorder address components into a logical Indian delivery format.
4. Understand common Indian address formats, abbreviations, wings, blocks, floors, flats, societies, buildings, roads, localities and landmarks.
5. Preserve the customer's intended destination.
6. Do not intentionally replace the customer's destination with a different nearby location.
7. You may clarify or add location information when Google Maps supports that interpretation.
8. If the address cannot reasonably be resolved, return UNRESOLVED.
9. Do not claim an address is resolved merely because a similar location exists.
10. Return only valid JSON matching the requested structure.

Customer's raw address:

${address}
`;

    const response = await fetch(
     "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],

          tools: [
            {
              googleMaps: {},
            },
          ],

          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["RESOLVED", "UNRESOLVED"],
                },
                cleanAddress: {
                  type: "string",
                },
                latitude: {
                  type: "number",
                },
                longitude: {
                  type: "number",
                },
                confidence: {
                  type: "string",
                  enum: ["HIGH", "MEDIUM", "LOW"],
                },
                reason: {
                  type: "string",
                },
              },
              required: [
                "status",
                "cleanAddress",
                "latitude",
                "longitude",
                "confidence",
                "reason",
              ],
            },
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Gemini request failed",
          details: data,
        },
        { status: response.status }
      );
    }

    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return NextResponse.json(
        {
          ok: false,
          error: "Gemini returned no result",
        },
        { status: 502 }
      );
    }

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "Gemini returned invalid JSON",
          raw: text,
        },
        { status: 502 }
      );
    }

    // Get the actual Google Maps URI returned by Maps grounding.
    const groundingChunks =
      data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    const mapsChunk = groundingChunks.find(
      (chunk: any) => chunk?.maps?.uri
    );

    const googleMapsLink = mapsChunk?.maps?.uri || null;

    return NextResponse.json({
      ok: true,
      status: result.status,
      cleanAddress: result.cleanAddress,
      googleMapsLink,
      latitude: result.latitude,
      longitude: result.longitude,
      confidence: result.confidence,
      reason: result.reason,
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
