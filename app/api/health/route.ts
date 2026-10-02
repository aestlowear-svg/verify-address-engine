import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "verify-address-engine",
    status: "running",
    timestamp: new Date().toISOString(),
  });
}
