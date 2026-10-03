import { NextResponse } from "next/server";
import crypto from "crypto";

type Address = {
  address1: string;
  address2?: string | null;
  city: string;
  province: string;
  provinceCode?: string | null;
  zip: string;
  country: string;
  countryCode?: string | null;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashAddress(address: Address): string {
  const raw = [
    address.address1,
    address.address2 || "",
    address.city,
    address.province,
    address.provinceCode || "",
    address.zip,
    address.country,
    address.countryCode || "",
  ]
    .map((value) => normalizeText(value))
    .join("|");

  return crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex");
}

function makeAddress(address: any): Address {
  return {
    address1: address?.address1 || "",
    address2: address?.address2 || "",
    city: address?.city || "",
    province: address?.province || "",
    provinceCode: address?.provinceCode || "",
    zip: address?.zip || "",
    country: address?.country || "",
    countryCode: address?.countryCodeV2 || "",
  };
}

function getMetafield(
  order: any,
  key: string
): string | null {
  return (
    order.metafields?.nodes?.find(
      (item: any) =>
        item?.namespace === "aestlo_address" &&
        item?.key === key
    )?.value || null
  );
}

function hasCustomerDetailsPreserved(
  original: Address,
  proposed: Address
): boolean {
  const originalText = normalizeText(
    `${original.address1} ${original.address2 || ""}`
  );

  const proposedText = normalizeText(
    `${proposed.address1} ${proposed.address2 || ""}`
  );

  const originalTokens =
    originalText.split(" ").filter(Boolean);

  const importantNumbers =
    originalTokens.filter((token) =>
      /^\d+[a-z]?$/.test(token)
    );

  for (const number of importantNumbers) {
    const numericPart = number.replace(
      /[a-z]$/i,
      ""
    );

    if (!proposedText.includes(numericPart)) {
      return false;
    }
  }

  const importantWords = [
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
    "bungalow",
    "bunglow",
    "plot",
    "apartment",
  ];

  for (const word of importantWords) {
    if (
      originalTokens.includes(word) &&
      !proposedText.includes(word)
    ) {
      return false;
    }
  }

  return true;
}

function buildGoogleAddress(
  original: Address,
  googleResult: any
): Address | null {
  const postalAddress =
    googleResult?.result?.address?.postalAddress;

  if (!postalAddress) {
    return null;
  }

  const googleLines =
    Array.isArray(postalAddress.addressLines)
      ? postalAddress.addressLines.filter(Boolean)
      : [];

  if (!googleLines.length) {
    return null;
  }

  const address1 = googleLines[0];

  let address2 =
    googleLines.length > 1
      ? googleLines.slice(1).join(", ")
      : "";

  if (original.address2) {
    const combined = normalizeText(
      `${address1} ${address2}`
    );

    const originalAddress2 =
      normalizeText(original.address2);

    if (
      originalAddress2 &&
      !combined.includes(originalAddress2)
    ) {
      address2 = address2
        ? `${address2}, ${original.address2}`
        : original.address2;
    }
  }

  return {
    address1,
    address2,
    city:
      postalAddress.locality ||
      original.city,
    province:
      postalAddress.administrativeArea ||
      original.province,
    provinceCode:
      original.provinceCode || "",
    zip:
      postalAddress.postalCode ||
      original.zip,
    country:
      original.country || "India",
    countryCode:
      postalAddress.regionCode ||
      original.countryCode ||
      "IN",
  };
}

async function getShopifyToken() {
  const shop =
    process.env.SHOPIFY_SHOP;

  const clientId =
    process.env.SHOPIFY_CLIENT_ID;

  const clientSecret =
    process.env.SHOPIFY_CLIENT_SECRET;

  if (
    !shop ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      "Shopify environment variables are missing"
    );
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:
          "client_credentials",
        client_id:
          clientId,
        client_secret:
          clientSecret,
      }).toString(),
    }
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.access_token
  ) {
    console.error(
      "Shopify authentication error:",
      data
    );

    throw new Error(
      "Could not authenticate with Shopify"
    );
  }

  return {
    shop,
    accessToken:
      data.access_token,
  };
}

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<
    string,
    unknown
  >
) {
  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json",
        "X-Shopify-Access-Token":
          accessToken,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const data =
    await response.json();

  if (
    !response.ok ||
    data.errors
  ) {
    console.error(
      "Shopify GraphQL error:",
      data
    );

    throw new Error(
      JSON.stringify(
        data.errors || data
      )
    );
  }

  return data;
}

export async function POST(
  request: Request
) {
  try {
    /*
     * ==================================================
     * 0. INTERNAL PROCESSOR SECURITY
     * ==================================================
     */

    const internalSecret =
      process.env.INTERNAL_PROCESSOR_SECRET;

    const suppliedSecret =
      request.headers.get(
        "x-internal-processor-secret"
      );

    if (
      !internalSecret ||
      suppliedSecret !== internalSecret
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const body =
      await request.json();

    const orderId =
      body.orderId;

    if (!orderId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "orderId is required",
        },
        { status: 400 }
      );
    }

    const {
      shop,
      accessToken,
    } = await getShopifyToken();

    /*
     * ==================================================
     * ORDER QUERY
     * ==================================================
     */

    const orderQuery = `
      query GetOrder($id: ID!) {
        order(id: $id) {
          id
          name

          cancelledAt
          cancelReason

          displayFulfillmentStatus

          shippingAddress {
            address1
            address2
            city
            province
            provinceCode
            zip
            country
            countryCodeV2
          }

          billingAddress {
            address1
            address2
            city
            province
            provinceCode
            zip
            country
            countryCodeV2
          }

          tags

          metafields(
            first: 20,
            namespace: "aestlo_address"
          ) {
            nodes {
              namespace
              key
              value
            }
          }
        }
      }
    `;

    /*
     * ==================================================
     * 1. GET CURRENT ORDER
     * ==================================================
     */

    const initialData =
      await shopifyGraphQL(
        shop,
        accessToken,
        orderQuery,
        {
          id: orderId,
        }
      );

    const order =
      initialData.data?.order;

    if (!order) {
      return NextResponse.json(
        {
          ok: false,
          error: "Order not found",
        },
        { status: 404 }
      );
    }

    /*
     * ==================================================
     * 2. SAFETY GATES
     * ==================================================
     */

    if (order.cancelledAt) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ORDER_CANCELLED",
        order: order.name,
      });
    }

    if (
      order.displayFulfillmentStatus !==
      "UNFULFILLED"
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "NOT_UNFULFILLED",
        order: order.name,
        fulfillmentStatus:
          order.displayFulfillmentStatus,
      });
    }

    if (!order.shippingAddress) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "NO_SHIPPING_ADDRESS",
        order: order.name,
      });
    }

    /*
     * ==================================================
     * 3. CURRENT SHIPPING ADDRESS
     * ==================================================
     */

    const currentAddress =
      makeAddress(
        order.shippingAddress
      );

    const currentHash =
      hashAddress(
        currentAddress
      );

    /*
     * ==================================================
     * 4. READ STORED STATE
     * ==================================================
     */

    const lastCheckedHash =
      getMetafield(
        order,
        "last_checked_hash"
      );

    const validationStatus =
      getMetafield(
        order,
        "validation_status"
      );

    const storedAttemptHash =
      getMetafield(
        order,
        "attempt_hash"
      );

    const storedCheckCount =
      Number(
        getMetafield(
          order,
          "check_count"
        ) || "0"
      );

    /*
     * ==================================================
     * 5. SAME ADDRESS = SKIP
     * ==================================================
     */

    if (
      lastCheckedHash ===
      currentHash
    ) {
      return NextResponse.json({
        ok: true,
        decision: "SKIP",
        reason:
          "ADDRESS_ALREADY_CHECKED",
        order: order.name,
        currentHash,
        validationStatus,
        checkCount:
          storedAttemptHash === currentHash
            ? storedCheckCount
            : 0,
      });
    }

    /*
     * ==================================================
     * 6. ADDRESS-SPECIFIC ATTEMPT COUNT
     * ==================================================
     *
     * The 3-attempt limit belongs to the current
     * shipping address hash.
     *
     * If the address changes, the hash changes and
     * the attempt count starts again from zero.
     */

    const checkCount =
      storedAttemptHash === currentHash
        ? storedCheckCount
        : 0;

    if (checkCount >= 3) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "ATTEMPT_CAP_REACHED",
        order: order.name,
        checkCount,
        currentHash,
      });
    }

    /*
     * ==================================================
     * 7. SEND ADDRESS TO GOOGLE
     * ==================================================
     */

    const origin =
      new URL(
        request.url
      ).origin;

    const addressForGoogle = [
      currentAddress.address1,
      currentAddress.address2,
      currentAddress.city,
      currentAddress.province,
      currentAddress.zip,
      currentAddress.country,
    ]
      .filter(Boolean)
      .join(", ");

    const googleResponse =
      await fetch(
        `${origin}/api/validate`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            address:
              addressForGoogle,
          }),
        }
      );

    const googleResult =
      await googleResponse.json();

    const newCheckCount =
      checkCount + 1;

    /*
     * ==================================================
     * 8. GOOGLE DID NOT ACCEPT
     * ==================================================
     *
     * Before saving ISSUE, re-fetch Shopify.
     *
     * If the address changed while Google was working,
     * discard the old result completely.
     */

    if (
      !googleResponse.ok ||
      googleResult.decision !==
        "ACCEPT"
    ) {
      const issueFinalData =
        await shopifyGraphQL(
          shop,
          accessToken,
          orderQuery,
          {
            id: orderId,
          }
        );

      const issueFinalOrder =
        issueFinalData.data?.order;

      if (!issueFinalOrder) {
        return NextResponse.json({
          ok: true,
          decision: "STOP",
          reason:
            "ORDER_DISAPPEARED_BEFORE_ISSUE_SAVE",
        });
      }

      if (
        issueFinalOrder.cancelledAt
      ) {
        return NextResponse.json({
          ok: true,
          decision: "STOP",
          reason:
            "ORDER_CANCELLED_BEFORE_ISSUE_SAVE",
        });
      }

      if (
        issueFinalOrder.displayFulfillmentStatus !==
        "UNFULFILLED"
      ) {
        return NextResponse.json({
          ok: true,
          decision: "STOP",
          reason:
            "ORDER_FULFILLED_BEFORE_ISSUE_SAVE",
          fulfillmentStatus:
            issueFinalOrder.displayFulfillmentStatus,
        });
      }

      if (
        !issueFinalOrder.shippingAddress
      ) {
        return NextResponse.json({
          ok: true,
          decision: "STOP",
          reason:
            "SHIPPING_ADDRESS_MISSING_BEFORE_ISSUE_SAVE",
        });
      }

      const issueFinalAddress =
        makeAddress(
          issueFinalOrder.shippingAddress
        );

      const issueFinalHash =
        hashAddress(
          issueFinalAddress
        );

      /*
       * Customer/admin changed the address while
       * Google was processing.
       *
       * Do not save the old result.
       */

      if (
        issueFinalHash !== currentHash
      ) {
        return NextResponse.json({
          ok: true,
          decision: "STOP",
          reason:
            "ADDRESS_CHANGED_BEFORE_ISSUE_SAVE",
          originalHash:
            currentHash,
          currentShopifyHash:
            issueFinalHash,
        });
      }

      /*
       * Save ISSUE only after confirming that the
       * current Shopify address is still the address
       * that was validated.
       */

      const saveIssueMutation = `
        mutation SaveCheck(
          $input: OrderInput!
        ) {
          orderUpdate(
            input: $input
          ) {
            order {
              id
              name
              tags
            }

            userErrors {
              field
              message
            }
          }
        }
      `;

      const saveIssueData =
        await shopifyGraphQL(
          shop,
          accessToken,
          saveIssueMutation,
          {
            input: {
              id: orderId,

              metafields: [
                {
                  namespace:
                    "aestlo_address",

                  key:
                    "last_checked_hash",

                  type:
                    "single_line_text_field",

                  value:
                    currentHash,
                },

                {
                  namespace:
                    "aestlo_address",

                  key:
                    "attempt_hash",

                  type:
                    "single_line_text_field",

                  value:
                    currentHash,
                },

                {
                  namespace:
                    "aestlo_address",

                  key:
                    "validation_status",

                  type:
                    "single_line_text_field",

                  value:
                    "ISSUE",
                },

                {
                  namespace:
                    "aestlo_address",

                  key:
                    "check_count",

                  type:
                    "number_integer",

                  value:
                    String(
                      newCheckCount
                    ),
                },

                {
                  namespace:
                    "aestlo_address",

                  key:
                    "original_address",

                  type:
                    "multi_line_text_field",

                  value:
                    addressForGoogle,
                },
              ],
            },
          }
        );

      const saveErrors =
        saveIssueData.data
          ?.orderUpdate
          ?.userErrors || [];

      if (saveErrors.length) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Could not save validation state",
            userErrors:
              saveErrors,
          },
          { status: 500 }
        );
      }

      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason:
          "GOOGLE_DID_NOT_ACCEPT",
        order:
          issueFinalOrder.name,
        google:
          googleResult,
        checkCount:
          newCheckCount,
        currentHash,
      });
    }

    /*
     * ==================================================
     * 9. BUILD STRUCTURED GOOGLE ADDRESS
     * ==================================================
     */

    const proposedAddress =
      buildGoogleAddress(
        currentAddress,
        googleResult
      );

    if (!proposedAddress) {
      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason:
          "GOOGLE_STRUCTURED_ADDRESS_MISSING",
        order: order.name,
      });
    }

    /*
     * ==================================================
     * 10. CUSTOMER DETAIL SAFETY CHECK
     * ==================================================
     */

    const customerDetailsPreserved =
      hasCustomerDetailsPreserved(
        currentAddress,
        proposedAddress
      );

    if (
      !customerDetailsPreserved
    ) {
      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason:
          "CUSTOMER_UNIT_DETAILS_NOT_PRESERVED",
        order: order.name,
        originalAddress:
          currentAddress,
        proposedAddress,
      });
    }

    /*
     * ==================================================
     * 11. HASH FINAL VALIDATED ADDRESS
     * ==================================================
     */

    const validatedHash =
      hashAddress(
        proposedAddress
      );

    /*
     * ==================================================
     * 12. FINAL RE-FETCH BEFORE WRITE
     * ==================================================
     */

    const finalData =
      await shopifyGraphQL(
        shop,
        accessToken,
        orderQuery,
        {
          id: orderId,
        }
      );

    const finalOrder =
      finalData.data?.order;

    if (!finalOrder) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "ORDER_DISAPPEARED_BEFORE_WRITE",
      });
    }

    if (
      finalOrder.cancelledAt
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "ORDER_CANCELLED_BEFORE_WRITE",
        cancelledAt:
          finalOrder.cancelledAt,
      });
    }

    if (
      finalOrder.displayFulfillmentStatus !==
      "UNFULFILLED"
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "ORDER_FULFILLED_BEFORE_WRITE",
        fulfillmentStatus:
          finalOrder.displayFulfillmentStatus,
      });
    }

    if (
      !finalOrder.shippingAddress
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "SHIPPING_ADDRESS_MISSING_BEFORE_WRITE",
      });
    }

    /*
     * ==================================================
     * 13. ADDRESS MUST STILL BE THE SAME
     * ==================================================
     */

    const finalCurrentAddress =
      makeAddress(
        finalOrder.shippingAddress
      );

    const finalHash =
      hashAddress(
        finalCurrentAddress
      );

    if (
      finalHash !== currentHash
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason:
          "ADDRESS_CHANGED_BEFORE_WRITE",
        originalHash:
          currentHash,
        currentShopifyHash:
          finalHash,
      });
    }

    /*
     * ==================================================
     * 14. UPDATE ONLY SHIPPING ADDRESS
     * ==================================================
     */

    const updateMutation = `
      mutation UpdateOrder(
        $input: OrderInput!
      ) {
        orderUpdate(
          input: $input
        ) {
          order {
            id
            name

            shippingAddress {
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }

            billingAddress {
              address1
              address2
              city
              province
              provinceCode
              zip
              country
              countryCodeV2
            }

            tags
          }

          userErrors {
            field
            message
          }
        }
      }
    `;

    const validatedAddressText = [
      proposedAddress.address1,
      proposedAddress.address2,
      proposedAddress.city,
      proposedAddress.province,
      proposedAddress.zip,
      proposedAddress.country,
    ]
      .filter(Boolean)
      .join(", ");

    const updateData =
      await shopifyGraphQL(
        shop,
        accessToken,
        updateMutation,
        {
          input: {
            id: orderId,

            /*
             * ONLY SHIPPING ADDRESS IS UPDATED.
             *
             * Billing address is NOT sent.
             * Tags are NOT sent.
             */

            shippingAddress: {
              address1:
                proposedAddress.address1,

              address2:
                proposedAddress.address2 ||
                null,

              city:
                proposedAddress.city,

              province:
                proposedAddress.province,

              provinceCode:
                proposedAddress.provinceCode ||
                null,

              zip:
                proposedAddress.zip,

              country:
                proposedAddress.country,

              countryCode:
                proposedAddress.countryCode ||
                "IN",
            },

            /*
             * Save the state of the address that
             * was actually written to Shopify.
             */

            metafields: [
              {
                namespace:
                  "aestlo_address",

                key:
                  "last_checked_hash",

                type:
                  "single_line_text_field",

                value:
                  validatedHash,
              },

              {
                namespace:
                  "aestlo_address",

                key:
                  "attempt_hash",

                type:
                  "single_line_text_field",

                value:
                  validatedHash,
              },

              {
                namespace:
                  "aestlo_address",

                key:
                  "validation_status",

                type:
                  "single_line_text_field",

                value:
                  "ACCEPTED",
              },

              {
                namespace:
                  "aestlo_address",

                key:
                  "check_count",

                type:
                  "number_integer",

                value:
                  String(
                    newCheckCount
                  ),
              },

              {
                namespace:
                  "aestlo_address",

                key:
                  "original_address",

                type:
                  "multi_line_text_field",

                value:
                  addressForGoogle,
              },

              {
                namespace:
                  "aestlo_address",

                key:
                  "validated_address",

                type:
                  "multi_line_text_field",

                value:
                  validatedAddressText,
              },
            ],
          },
        }
      );

    const result =
      updateData.data
        ?.orderUpdate;

    if (
      result?.userErrors?.length
    ) {
      return NextResponse.json(
        {
          ok: false,
          decision:
            "UPDATE_FAILED",
          userErrors:
            result.userErrors,
        },
        { status: 400 }
      );
    }

    /*
     * ==================================================
     * 15. SUCCESS
     * ==================================================
     */

    return NextResponse.json({
      ok: true,
      decision: "UPDATED",
      order:
        result?.order,
      originalAddress:
        currentAddress,
      proposedAddress,
      billingAddress:
        result?.order
          ?.billingAddress,
      tags:
        result?.order?.tags,
      google:
        googleResult,
      originalHash:
        currentHash,
      validatedHash,
      checkCount:
        newCheckCount,
    });
  } catch (error) {
    console.error(
      "Shopify address processor error:",
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Internal server error",
      },
      { status: 500 }
    );
  }
}
