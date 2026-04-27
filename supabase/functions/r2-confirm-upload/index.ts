/**
 * r2-confirm-upload — Supabase Edge Function
 *
 * Marks a pending order_files record as "complete" after the client
 * has successfully PUT the file to R2.
 *
 * Call this after receiving HTTP 200 from the presigned PUT URL.
 *
 * POST body (JSON):
 * {
 *   file_id: string  (UUID returned by r2-presign-upload)
 * }
 *
 * Response (JSON):
 * {
 *   file_id:   string
 *   r2_key:    string
 *   filename:  string
 *   category:  string
 *   size_bytes: number
 *   confirmed: true
 * }
 *
 * PRI-237
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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

  // Fetch the pending record — must be owned by this user and still pending
  const { data: file, error: fetchError } = await supabase
    .from("order_files")
    .select("id, r2_key, filename, category, size_bytes, upload_status, uploaded_by, deleted_at")
    .eq("id", file_id)
    .single();

  if (fetchError || !file) {
    return errorResponse("File record not found", 404, origin);
  }

  if (file.deleted_at) {
    return errorResponse("File has been deleted", 410, origin);
  }

  if (file.upload_status === "complete") {
    // Idempotent — already confirmed, just return success
    return jsonResponse(
      {
        file_id: file.id,
        r2_key: file.r2_key,
        filename: file.filename,
        category: file.category,
        size_bytes: file.size_bytes,
        confirmed: true,
      },
      200,
      origin,
    );
  }

  if (file.upload_status === "failed") {
    return errorResponse("Upload was marked as failed — request a new presigned URL", 409, origin);
  }

  if (file.upload_status !== "pending") {
    return errorResponse("Unexpected upload_status", 500, origin);
  }

  // Only the uploader (or an admin) may confirm
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const isUploader = file.uploaded_by === user.id;
  const isAdmin = profile?.role === "admin";
  if (!isUploader && !isAdmin) {
    return errorResponse("Only the uploader or an admin may confirm this upload", 403, origin);
  }

  // Mark as complete
  const { error: updateError } = await supabase
    .from("order_files")
    .update({ upload_status: "complete" })
    .eq("id", file_id);

  if (updateError) {
    console.error("DB update error:", updateError);
    return errorResponse("Failed to confirm upload", 500, origin);
  }

  return jsonResponse(
    {
      file_id: file.id,
      r2_key: file.r2_key,
      filename: file.filename,
      category: file.category,
      size_bytes: file.size_bytes,
      confirmed: true,
    },
    200,
    origin,
  );
});
