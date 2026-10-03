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

function hashAddress(address: Address) {
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
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function getShopifyToken() {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error("Shopify environment variables are missing");
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }
  );

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error("Could not authenticate with Shopify");
  }

  return {
    shop,
    accessToken: data.access_token,
  };
}

async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
) {
  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/2026-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query,
        variables,
      }),
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors) {
    throw new Error(JSON.stringify(data.errors || data));
  }

  return data;
}

function getMetafield(order: any, key: string) {
  return (
    order.metafields?.find(
      (item: any) =>
        item?.namespace === "aestlo_address" && item?.key === key
    )?.value || null
  );
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const orderId = body.orderId;

    if (!orderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "orderId is required",
        },
        { status: 400 }
      );
    }

    const { shop, accessToken } = await getShopifyToken();

    // --------------------------------------------------
    // 1. GET CURRENT ORDER
    // --------------------------------------------------

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
            identifiers: [
              { namespace: "aestlo_address", key: "last_checked_hash" }
              { namespace: "aestlo_address", key: "validation_status" }
              { namespace: "aestlo_address", key: "check_count" }
              { namespace: "aestlo_address", key: "original_address" }
              { namespace: "aestlo_address", key: "validated_address" }
            ]
          ) {
            namespace
            key
            value
          }
        }
      }
    `;

    const initialData = await shopifyGraphQL(
      shop,
      accessToken,
      orderQuery,
      { id: orderId }
    );

    const order = initialData.data?.order;

    if (!order) {
      return NextResponse.json(
        {
          ok: false,
          error: "Order not found",
        },
        { status: 404 }
      );
    }

    // --------------------------------------------------
    // 2. SAFETY GATE
    // --------------------------------------------------

    if (order.cancelledAt) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ORDER_CANCELLED",
        order: order.name,
      });
    }

    if (order.displayFulfillmentStatus !== "UNFULFILLED") {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "NOT_UNFULFILLED",
        fulfillmentStatus: order.displayFulfillmentStatus,
        order: order.name,
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

    // --------------------------------------------------
    // 3. CURRENT ADDRESS + HASH
    // --------------------------------------------------

    const currentAddress = makeAddress(order.shippingAddress);
    const currentHash = hashAddress(currentAddress);

    const lastCheckedHash = getMetafield(
      order,
      "last_checked_hash"
    );

    const validationStatus = getMetafield(
      order,
      "validation_status"
    );

    const checkCount = Number(
      getMetafield(order, "check_count") || "0"
    );

    // --------------------------------------------------
    // 4. SAME ADDRESS = DO NOT CALL GOOGLE AGAIN
    // --------------------------------------------------

    if (lastCheckedHash === currentHash) {
      return NextResponse.json({
        ok: true,
        decision: "SKIP",
        reason: "ADDRESS_ALREADY_CHECKED",
        order: order.name,
        currentHash,
        validationStatus,
        checkCount,
      });
    }

    // --------------------------------------------------
    // 5. MAX 3 ATTEMPTS FOR SAME ADDRESS
    // --------------------------------------------------

    if (checkCount >= 3) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ATTEMPT_CAP_REACHED",
        order: order.name,
        checkCount,
      });
    }

    // --------------------------------------------------
    // 6. SEND ADDRESS TO GOOGLE
    // --------------------------------------------------

    const origin = new URL(request.url).origin;

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

    const googleResponse = await fetch(
      `${origin}/api/validate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          address: addressForGoogle,
        }),
      }
    );

    const googleResult = await googleResponse.json();

    const newCheckCount = checkCount + 1;

    // --------------------------------------------------
    // 7. GOOGLE DID NOT ACCEPT
    // --------------------------------------------------

    if (
      !googleResponse.ok ||
      googleResult.decision !== "ACCEPT"
    ) {
      const saveIssueMutation = `
        mutation SaveCheck($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
            }

            userErrors {
              field
              message
            }
          }
        }
      `;

      await shopifyGraphQL(
        shop,
        accessToken,
        saveIssueMutation,
        {
          input: {
            id: orderId,

            metafields: [
              {
                namespace: "aestlo_address",
                key: "last_checked_hash",
                type: "single_line_text_field",
                value: currentHash,
              },
              {
                namespace: "aestlo_address",
                key: "validation_status",
                type: "single_line_text_field",
                value: "ISSUE",
              },
              {
                namespace: "aestlo_address",
                key: "check_count",
                type: "number_integer",
                value: String(newCheckCount),
              },
              {
                namespace: "aestlo_address",
                key: "original_address",
                type: "multi_line_text_field",
                value: addressForGoogle,
              },
            ],
          },
        }
      );

      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason: "GOOGLE_DID_NOT_ACCEPT",
        order: order.name,
        google: googleResult,
        checkCount: newCheckCount,
      });
    }

    // --------------------------------------------------
    // 8. GET GOOGLE STRUCTURED ADDRESS
    // --------------------------------------------------

    const postalAddress =
      googleResult.result?.address?.postalAddress || null;

    if (!postalAddress) {
      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason: "GOOGLE_STRUCTURED_ADDRESS_MISSING",
        order: order.name,
      });
    }

    const googleLines = Array.isArray(postalAddress.addressLines)
      ? postalAddress.addressLines.filter(Boolean)
      : [];

    if (!googleLines.length) {
      return NextResponse.json({
        ok: true,
        decision: "ISSUE",
        reason: "GOOGLE_ADDRESS_LINES_MISSING",
        order: order.name,
      });
    }

    const googleAddress1 = googleLines[0];

    const googleAddress2 =
      googleLines.length > 1
        ? googleLines.slice(1).join(", ")
        : "";

    const proposedAddress: Address = {
      address1: googleAddress1,
      address2: googleAddress2,
      city:
        postalAddress.locality ||
        currentAddress.city,
      province:
        postalAddress.administrativeArea ||
        currentAddress.province,
      provinceCode:
        currentAddress.provinceCode || "",
      zip:
        postalAddress.postalCode ||
        currentAddress.zip,
      country:
        currentAddress.country || "India",
      countryCode:
        postalAddress.regionCode ||
        currentAddress.countryCode ||
        "IN",
    };

    // --------------------------------------------------
    // 9. FINAL RE-FETCH BEFORE WRITE
    // --------------------------------------------------

    const finalData = await shopifyGraphQL(
      shop,
      accessToken,
      orderQuery,
      { id: orderId }
    );

    const finalOrder = finalData.data?.order;

    if (!finalOrder) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ORDER_DISAPPEARED_BEFORE_WRITE",
      });
    }

    if (
      finalOrder.cancelledAt ||
      finalOrder.displayFulfillmentStatus !== "UNFULFILLED"
    ) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ORDER_CHANGED_BEFORE_WRITE",
        fulfillmentStatus:
          finalOrder.displayFulfillmentStatus,
        cancelledAt: finalOrder.cancelledAt,
      });
    }

    // --------------------------------------------------
    // 10. MAKE SURE SHIPPING ADDRESS DID NOT CHANGE
    // --------------------------------------------------

    const finalCurrentAddress = makeAddress(
      finalOrder.shippingAddress
    );

    const finalHash = hashAddress(finalCurrentAddress);

    if (finalHash !== currentHash) {
      return NextResponse.json({
        ok: true,
        decision: "STOP",
        reason: "ADDRESS_CHANGED_BEFORE_WRITE",
      });
    }

    // --------------------------------------------------
    // 11. UPDATE ONLY SHIPPING ADDRESS
    // --------------------------------------------------

    const updateMutation = `
      mutation UpdateOrder($input: OrderInput!) {
        orderUpdate(input: $input) {
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

    const updateData = await shopifyGraphQL(
      shop,
      accessToken,
      updateMutation,
      {
        input: {
          id: orderId,

          shippingAddress: {
            address1: proposedAddress.address1,
            address2: proposedAddress.address2 || null,
            city: proposedAddress.city,
            province: proposedAddress.province,
            provinceCode:
              proposedAddress.provinceCode || null,
            zip: proposedAddress.zip,
            country: proposedAddress.country,
            countryCode:
              proposedAddress.countryCode || "IN",
          },

          metafields: [
            {
              namespace: "aestlo_address",
              key: "last_checked_hash",
              type: "single_line_text_field",
              value: currentHash,
            },
            {
              namespace: "aestlo_address",
              key: "validation_status",
              type: "single_line_text_field",
              value: "ACCEPTED",
            },
            {
              namespace: "aestlo_address",
              key: "check_count",
              type: "number_integer",
              value: String(newCheckCount),
            },
            {
              namespace: "aestlo_address",
              key: "original_address",
              type: "multi_line_text_field",
              value: addressForGoogle,
            },
            {
              namespace: "aestlo_address",
              key: "validated_address",
              type: "multi_line_text_field",
              value: [
                proposedAddress.address1,
                proposedAddress.address2,
                proposedAddress.city,
                proposedAddress.province,
                proposedAddress.zip,
                proposedAddress.country,
              ]
                .filter(Boolean)
                .join(", "),
            },
          ],
        },
      }
    );

    const result = updateData.data?.orderUpdate;

    if (result?.userErrors?.length) {
      return NextResponse.json(
        {
          ok: false,
          decision: "UPDATE_FAILED",
          userErrors: result.userErrors,
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      decision: "UPDATED",
      order: result?.order,
      originalAddress: currentAddress,
      proposedAddress,
      google: googleResult,
      currentHash,
      checkCount: newCheckCount,
    });
  } catch (error) {
    console.error(
      "Shopify process test error:",
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
