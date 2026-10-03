import { NextResponse } from "next/server";

type GoogleComponent = {
  componentName?: {
    text?: string;
  };
  componentType?: string;
  confirmationLevel?: string;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractImportantTokens(address: string): string[] {
  const normalized = normalizeText(address);

  const tokens = normalized
    .split(" ")
    .filter((token) => token.length > 1);

  return tokens;
}

function googleContainsCustomerDetails(
  originalAddress: string,
  components: GoogleComponent[]
): boolean {
  const originalTokens = extractImportantTokens(originalAddress);

  const googleText = normalizeText(
    components
      .map((component) => component.componentName?.text || "")
      .join(" ")
  );

  /*
   * Protect customer-specific numeric information.
   *
   * Examples:
   * 3202
   * 111
   * 23
   * 302
   *
   * We don't allow Google to silently remove an important
   * number supplied by the customer.
   */
  const originalNumbers = originalTokens.filter((token) =>
    /^\d+[a-z]?$/.test(token)
  );

  for (const number of originalNumbers) {
    const numericPart = number.replace(/[a-z]$/i, "");

    if (!googleText.includes(numericPart)) {
      return false;
    }
  }

  /*
   * Protect common unit/building identifiers.
   *
   * We don't require every word to match because Google
   * can legitimately reorder, normalize, or spell-correct
   * address components.
   */
  const importantWords = originalTokens.filter((token) =>
    [
      "flat",
      "floor",
      "wing",
      "shop",
      "room",
      "house",
      "building",
      "tower",
      "block",
      "phase",
    ].includes(token)
  );

  for (const word of importantWords) {
    if (!googleText.includes(word)) {
      /*
       * Don't automatically reject here.
       *
       * Google may represent the same information using a
       * different component structure.
       *
       * Numeric identifiers above are treated more strictly.
       */
    }
  }

  return true;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const address = body.address;

    if (!address || typeof address !== "string") {
      return NextResponse.json(
        {
          ok: false,
          decision: "ISSUE",
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
          decision: "ISSUE",
          error: "GOOGLE_MAPS_API_KEY is not configured",
        },
        { status: 500 }
      );
    }

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

    const components: GoogleComponent[] =
      validatedAddress?.addressComponents || [];

    const possibleNextAction =
      verdict?.possibleNextAction || null;

    const addressComplete =
      verdict?.addressComplete === true;

    const validationGranularity =
      verdict?.validationGranularity || null;

    const geocodeGranularity =
      verdict?.geocodeGranularity || null;

    const hasUnconfirmedComponents =
      verdict?.hasUnconfirmedComponents === true;

    const hasInferredComponents =
      verdict?.hasInferredComponents === true;

    const hasReplacedComponents =
      verdict?.hasReplacedComponents === true;

    /*
     * Google must provide a meaningful geographic result.
     */
    const hasUsableGeocode =
      !!geocode?.location &&
      typeof geocode.location.latitude === "number" &&
      typeof geocode.location.longitude === "number";

    /*
     * Google must consider the address acceptable.
     */
    const googleAccepts =
      possibleNextAction === "ACCEPT" &&
      addressComplete === true &&
      !!formattedAddress &&
      hasUsableGeocode;

    /*
     * Cross-check customer-specific information.
     *
     * This does NOT try to rewrite the address.
     * It only prevents us from blindly removing important
     * customer-entered information.
     */
    const customerInformationPreserved =
      googleContainsCustomerDetails(address, components);

    /*
     * Final decision.
     *
     * IMPORTANT:
     * Unconfirmed components alone do NOT automatically mean
     * the address is bad.
     *
     * Google may return a complete usable address while some
     * customer-specific components remain unconfirmed.
     *
     * We only reject when our safety comparison detects that
     * an important numeric identifier disappeared.
     */
    const safeToUpdate =
      googleAccepts &&
      customerInformationPreserved;

    return NextResponse.json({
      ok: true,

      decision: safeToUpdate ? "ACCEPT" : "ISSUE",

      originalAddress: address,

      finalAddress: safeToUpdate
        ? formattedAddress
        : null,

      safety: {
        googleAccepted: googleAccepts,
        customerInformationPreserved,
        hasUnconfirmedComponents,
        hasInferredComponents,
        hasReplacedComponents,
      },

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
