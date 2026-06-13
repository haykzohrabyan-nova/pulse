/**
 * send-pickup-code — Supabase Edge Function
 *
 * Generates a 6-digit SMS verification code for a local-pickup order,
 * persists it in `pickup_verifications` (service-role only table),
 * and delivers it via Twilio SMS.  The code is never sent to the browser.
 *
 * POST body (JSON):
 * {
 *   order_id:      string  (UUID)
 *   phone:         string  (E.164 or readable format — passed straight to Twilio)
 *   order_ref:     string  (human-readable order number, included in SMS)
 *   picked_up_by?: string  (customer name — included in SMS)
 *   staff_name?:   string  (staff handing off — stored for context)
 * }
 *
 * Response (JSON):
 * { success: true }  — 200
 * { error: string }  — 400 / 500
 *
 * Required Supabase secrets:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
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

  let body: {
    order_id?: string;
    phone?: string;
    order_ref?: string;
    picked_up_by?: string;
    staff_name?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, origin);
  }

  const { order_id, phone, order_ref, picked_up_by } = body;

  if (!order_id || !phone) {
    return errorResponse("order_id and phone are required", 400, origin);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Confirm the order exists before issuing a code
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id")
    .eq("id", order_id)
    .single();

  if (orderErr || !order) {
    return errorResponse("Order not found", 404, origin);
  }

  // Generate 6-digit code and 5-minute expiry
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires_at = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error: upsertErr } = await supabase
    .from("pickup_verifications")
    .upsert(
      { order_id, phone, code, expires_at, verified: false },
      { onConflict: "order_id" },
    );

  if (upsertErr) {
    console.error("upsert error:", upsertErr);
    return errorResponse("Failed to store verification code", 500, origin);
  }

  // Send SMS via Twilio
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const authToken  = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const fromNumber = Deno.env.get("TWILIO_PHONE_NUMBER")!;

  const smsBody = [
    "Bazaar Printing — Pickup Verification",
    "",
    `Order: ${order_ref || order_id}`,
    picked_up_by ? `Customer: ${picked_up_by}` : "",
    "",
    `Your confirmation code is: ${code}`,
    "",
    "This code expires in 5 minutes.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  const twilioUrl =
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  let twilioRes: Response;
  try {
    twilioRes = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: fromNumber, To: phone, Body: smsBody }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error("Twilio fetch error:", err);
    return errorResponse("SMS delivery failed — network timeout", 500, origin);
  }

  if (!twilioRes.ok) {
    const errText = await twilioRes.text();
    console.error("Twilio error response:", errText);
    return errorResponse(`SMS delivery failed: ${twilioRes.status}`, 500, origin);
  }

  return jsonResponse({ success: true }, 200, origin);
});
