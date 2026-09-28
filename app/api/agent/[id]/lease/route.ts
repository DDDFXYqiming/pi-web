import { NextResponse } from "next/server";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";
import { getRpcSession } from "@/lib/rpc-manager";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Optional attention metadata on the existing lease. Never start a session
  // just because a background browser sends a heartbeat.
  const body = await req.json().catch(() => null);
  const session = getRpcSession(id);
  if (session?.isAlive()) session.reportBrowserPresence(body?.presence);
  return NextResponse.json({
    success: true,
    renewed: renewSessionLivenessLeases(id),
  }, { headers: { "Cache-Control": "no-store" } });
}
