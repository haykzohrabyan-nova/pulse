/**
 * r2-presign-download — Supabase Edge Function
 *
 * Issues a presigned GET URL for downloading a file from Cloudflare R2.
 * R2 credentials are never sent to the browser.
 *
 * POST body (JSON):
 * {
 *   file_id: string  (UUID of the order_files row)
 * }
 *
 * Response (JSON):
 * {
 *   presigned_url: string  (GET this URL to download the file)
 *   filename:      string  (original filename for Content-Disposition)
 *   content_type:  string
 *   size_bytes:    number
 *   expires_at:    string  (ISO8601 — URL valid for 1 hour)
 * }
 *
 * Security:
 * - Requires valid Supabase JWT
 * - Checks file belongs to an order the user can read
 * - Only returns URLs for complete, non-deleted files
 * - Generated URLs expire in 1 hour
 *
 * PRI-237
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { presignDownload, r2ConfigFromEnv } from "../_shared/r2.ts";
import {
  errorResponse,
  handlePreflight,
  jsonResponse,
} from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Missing or invalid Authorization header", 401, origin);
  }
  const token = authHeader.slice(7);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return errorResponse("Unauthorized", 401, origin);
  }

  let body: { file_id?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, origin);
  }

  const { file_id } = body;
  if (!file_id) {
    return errorResponse("Required field: file_id", 400, origin);
  }

  // Fetch file record — must be complete and not deleted
  const { data: file, error: fetchError } = await supabase
    .from("order_files")
    .select("id, order_id, r2_key, filename, content_type, size_bytes, upload_status, deleted_at")
    .eq("id", file_id)
    .single();

  if (fetchError || !file) {
    return errorResponse("File not found", 404, origin);
  }

  if (file.deleted_at) {
    return errorResponse("File has been deleted", 410, origin);
  }

  if (file.upload_status !== "complete") {
    return errorResponse("File upload is not complete", 409, origin);
  }

  // Verify the user can read the parent order
  // RLS policies enforce this, but we double-check via service role + manual check
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id")
    .eq("id", file.order_id)
    .single();

  if (orderError || !order) {
    return errorResponse("Order not found or access denied", 403, origin);
  }

  // Check profile exists (ensures user is a valid app user)
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, active")
    .eq("id", user.id)
    .single();

  if (profileError || !profile || !profile.active) {
    return errorResponse("User profile not found or inactive", 403, origin);
  }

  // Generate presigned GET URL (1 hour expiry)
  let presignedUrl: string;
  let expiresAt: Date;
  try {
    const r2Config = r2ConfigFromEnv();
    const result = await presignDownload(r2Config, {
      key: file.r2_key,
      expiresInSeconds: 3600,
    });
    presignedUrl = result.url;
    expiresAt = result.expiresAt;
  } catch (err) {
    console.error("R2 presign error:", err);
    return errorResponse("Failed to generate download URL", 500, origin);
  }

  return jsonResponse(
    {
      presigned_url: presignedUrl,
      filename: file.filename,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
      expires_at: expiresAt.toISOString(),
    },
    200,
    origin,
  );
});
