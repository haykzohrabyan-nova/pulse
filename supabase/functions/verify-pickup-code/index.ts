/**
 * verify-pickup-code — Supabase Edge Function
 *
 * Validates a 6-digit SMS code against the server-side record in
 * `pickup_verifications`.  Returns { success: true } on a valid, unexpired
 * match so the frontend can proceed to update order status via the normal
 * updateOrder() path.  Cleans up the record after a successful verification.
 *
 * POST body (JSON):
 * {
 *   order_id: string  (UUID)
 *   code:     string  (6-digit code entered by customer)
 * }
 *
 * Response (JSON):
 * { success: true }                                          — 200
 * { error: "No pending verification found" }                — 404
 * { error: "Code expired. Please request a new one." }     — 410
 * { error: "Invalid code. Please try again." }             — 400
 * { error: string }                                         — 500
 *
 * Required Supabase secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse, handlePreflight, jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  let body: { order_id?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, origin);
  }

  const { order_id, code } = body;

  if (!order_id || !code) {
    return errorResponse("order_id and code are required", 400, origin);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: verif, error: fetchErr } = await supabase
    .from("pickup_verifications")
    .select("code, expires_at")
    .eq("order_id", order_id)
    .single();

  if (fetchErr || !verif) {
    return errorResponse("No pending verification found", 404, origin);
  }

  if (new Date(verif.expires_at) < new Date()) {
    return errorResponse("Code expired. Please request a new one.", 410, origin);
  }

  if (verif.code !== code.trim()) {
    return errorResponse("Invalid code. Please try again.", 400, origin);
  }

  // Clean up — code is single-use
  await supabase
    .from("pickup_verifications")
    .delete()
    .eq("order_id", order_id);

  return jsonResponse({ success: true }, 200, origin);
});
