import { NextResponse } from "next/server";

const SHOPIFY_API_VERSION = "2026-10";
const PROCESSOR_PATH = "/api/shopify-process-test";

type ShopifyOrder = {
  id: string;
  name: string;
  displayFulfillmentStatus: string;
  cancelledAt: string | null;
  shippingAddress: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    zip: string | null;
    country: string | null;
    countryCode: string | null;
  } | null;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

async function getShopifyAccessToken(): Promise<string> {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    throw new Error("Missing Shopify environment variables");
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Shopify token request failed: ${text}`);
  }

  const json = await response.json();

  if (!json.access_token) {
    throw new Error("Shopify access token missing");
  }

  return json.access_token;
}

async function shopifyGraphQL<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const shop = process.env.SHOPIFY_SHOP;

  if (!shop) {
    throw new Error("Missing SHOPIFY_SHOP");
  }

  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
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
      cache: "no-store",
    }
  );

  const json: GraphQLResponse<T> = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(json)}`
    );
  }

  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL error: ${json.errors
        .map((e) => e.message)
        .join("; ")}`
    );
  }

  if (!json.data) {
    throw new Error("Shopify GraphQL returned no data");
  }

  return json.data;
}

const ORDERS_QUERY = `
  query BackfillOrders($first: Int!, $after: String) {
    orders(
      first: $first
      after: $after
      query: "fulfillment_status:unfulfilled"
      sortKey: CREATED_AT
      reverse: true
    ) {
      nodes {
        id
        name
        displayFulfillmentStatus
        cancelledAt
        shippingAddress {
          address1
          address2
          city
          province
          provinceCode
          zip
          country
          countryCode
        }
      }

      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

type OrdersQueryResult = {
  orders: {
    nodes: ShopifyOrder[];
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
};

export async function POST(request: Request) {
  try {
    // ------------------------------------------------------------
    // 1. SECURITY
    // ------------------------------------------------------------

    const suppliedSecret =
      request.headers.get("x-internal-processor-secret") || "";

    const internalSecret = process.env.INTERNAL_PROCESSOR_SECRET || "";

    if (!internalSecret) {
      return NextResponse.json(
        {
          ok: false,
          error: "INTERNAL_PROCESSOR_SECRET is not configured",
        },
        { status: 500 }
      );
    }

    if (
      !suppliedSecret ||
      suppliedSecret.length !== internalSecret.length ||
      !timingSafeEqual(suppliedSecret, internalSecret)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: "Unauthorized",
        },
        { status: 401 }
      );
    }

    // ------------------------------------------------------------
    // 2. READ REQUEST
    // ------------------------------------------------------------

    const body = await request.json().catch(() => ({}));

    const requestedLimit = Number(body.limit ?? 5);

    // Never allow a huge batch.
    const limit = Math.min(
      Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 5, 1),
      5
    );

    const dryRun = body.dryRun !== false;

    const after =
      typeof body.after === "string" && body.after.length > 0
        ? body.after
        : null;

    // ------------------------------------------------------------
    // 3. GET SHOPIFY TOKEN
    // ------------------------------------------------------------

    const accessToken = await getShopifyAccessToken();

    // ------------------------------------------------------------
    // 4. FETCH ONLY UNFULFILLED ORDERS
    // ------------------------------------------------------------

    const result = await shopifyGraphQL<OrdersQueryResult>(
      accessToken,
      ORDERS_QUERY,
      {
        first: limit,
        after,
      }
    );

    const orders = result.orders.nodes;

    // ------------------------------------------------------------
    // 5. EXTRA SAFETY FILTER
    // ------------------------------------------------------------

    const eligibleOrders = orders.filter((order) => {
      if (order.cancelledAt) return false;

      if (order.displayFulfillmentStatus !== "UNFULFILLED") {
        return false;
      }

      if (!order.shippingAddress) {
        return false;
      }

      return true;
    });

    // ------------------------------------------------------------
    // 6. DRY RUN
    // ------------------------------------------------------------

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        mode: "DRY_RUN",

        message:
          "No orders were changed. These are the UNFULFILLED orders that would be sent to the existing processor.",

        requestedLimit: limit,

        found: orders.length,

        eligible: eligibleOrders.length,

        skipped: orders.length - eligibleOrders.length,

        orders: eligibleOrders.map((order) => ({
          id: order.id,
          name: order.name,
          fulfillmentStatus: order.displayFulfillmentStatus,
          shippingAddress: order.shippingAddress,
        })),

        nextCursor: result.orders.pageInfo.hasNextPage
          ? result.orders.pageInfo.endCursor
          : null,

        hasNextPage: result.orders.pageInfo.hasNextPage,
      });
    }

    // ------------------------------------------------------------
    // 7. REAL PROCESSING
    // ------------------------------------------------------------

    const baseUrl = new URL(request.url).origin;

    const results: Array<Record<string, unknown>> = [];

    for (const order of eligibleOrders) {
      try {
        const processorResponse = await fetch(
          `${baseUrl}${PROCESSOR_PATH}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-processor-secret": internalSecret,
            },
            body: JSON.stringify({
              orderId: order.id,
            }),
            cache: "no-store",
          }
        );

        const processorJson = await processorResponse
          .json()
          .catch(() => ({
            ok: false,
            error: "Processor returned invalid JSON",
          }));

        results.push({
          order: order.name,
          orderId: order.id,
          httpStatus: processorResponse.status,
          result: processorJson,
        });
      } catch (error) {
        results.push({
          order: order.name,
          orderId: order.id,
          result: {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Unknown processor error",
          },
        });
      }
    }

    // ------------------------------------------------------------
    // 8. RETURN PAGINATION INFO
    // ------------------------------------------------------------

    return NextResponse.json({
      ok: true,
      mode: "LIVE",

      message:
        "Backfill batch completed using the existing address processor.",

      processed: results.length,

      results,

      nextCursor: result.orders.pageInfo.hasNextPage
        ? result.orders.pageInfo.endCursor
        : null,

      hasNextPage: result.orders.pageInfo.hasNextPage,
    });
  } catch (error) {
    console.error("BACKFILL_ERROR", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Unknown backfill error",
      },
      { status: 500 }
    );
  }
}

// ------------------------------------------------------------
// Constant-time-ish secret comparison
// ------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
