import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const address = body.address;
    const rating = body.rating || "UNKNOWN";
    const issueDetails = body.issueDetails || "";

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
You are an Indian e-commerce delivery address restructuring specialist.

Your ONLY job in this step is to rewrite the customer's address into a
clear, properly structured, delivery-friendly Indian address.

This is a RESTRUCTURING task.

You MUST NOT use Google Maps.
You MUST NOT use external geographic information.
You MUST NOT invent missing information.

CUSTOMER ADDRESS:
${address}

iTHINK ADDRESS RATING:
${rating}

iTHINK PROBLEM / MISSING INFORMATION:
${issueDetails || "None provided"}

STRICT RULES:

1. Preserve the customer's intended destination.

2. Correct obvious spelling mistakes.

3. Correct punctuation and spacing.

4. Reorder the address into a logical Indian delivery format.

5. Properly separate:
   - Flat / House / Shop / Room number
   - Floor
   - Wing / Block
   - Building / Society
   - Road / Street
   - Area / Locality
   - Landmark
   - City
   - State
   - PIN code

6. Understand common Indian abbreviations and address-writing patterns.

7. Do NOT invent a flat number, house number, society, landmark,
   locality, road, city, state or PIN code.

8. Do NOT add information merely because it seems likely.

9. If the customer supplied information in an unusual order,
   intelligently reorder it without changing its meaning.

10. Preserve useful customer-specific information such as:
    flat number, house number, shop number, room number, wing,
    floor, block, society and landmark.

11. Do not remove useful information merely to make the address shorter.

12. If iThink provided missing/problem information, use it only to
    understand what is wrong with the supplied address. Do not invent
    the missing information.

13. The output must represent the SAME customer-provided destination.

14. This first pass does NOT verify whether the location exists.
    Geographic verification will happen separately through Google.

15. Even when the address cannot be geographically verified,
    return the best safe restructuring of the information actually
    supplied by the customer.

16. Return ONLY valid JSON matching the requested schema.

Example:

Input:
"5-0-1 B green vally society near phoenix mall wakad pune"

A suitable restructuring could be:
"Flat 5-0-1 B, Green Valley Society, Near Phoenix Mall, Wakad, Pune"

Do not add a PIN code or other location information unless it was
actually present in the input.

Remember:
RESTRUCTURE.
DO NOT GUESS.
DO NOT GEOCODE.
DO NOT INVENT.
`;

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
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
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                cleanAddress: {
                  type: "string",
                },
                changes: {
                  type: "array",
                  items: {
                    type: "string",
                  },
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
                "cleanAddress",
                "changes",
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
      console.error("Gemini API error:", data);

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

    return NextResponse.json({
      ok: true,
      model: "gemini-3.5-flash-lite",
      rating,
      originalAddress: address,
      cleanAddress: result.cleanAddress,
      changes: result.changes,
      confidence: result.confidence,
      reason: result.reason,
    });
  } catch (error) {
    console.error("Address restructuring error:", error);

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
