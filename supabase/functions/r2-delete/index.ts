/**
 * r2-delete — Supabase Edge Function
 *
 * Soft-deletes a file (sets deleted_at on order_files row) and,
 * for admin callers, optionally hard-deletes the object from R2.
 *
 * Deletion/archive policy:
 * - Any eligible user (admin, supervisor) can soft-delete — sets deleted_at,
 *   hides the file from all UI queries via the updated RLS policy.
 * - Hard delete from R2 is restricted to admins and requires `hard_delete: true`.
 * - For completed orders, soft-deleted files are retained for 30 days before
 *   a scheduled cleanup job hard-deletes them from R2.
 * - Admins may hard-delete immediately (e.g. GDPR/accidental upload).
 *
 * POST body (JSON):
 * {
 *   file_id:      string   (UUID of the order_files row)
 *   hard_delete?: boolean  (default false — admin only; removes bytes from R2 now)
 * }
 *
 * Response (JSON):
 * {
 *   file_id:       string
 *   soft_deleted:  true
 *   hard_deleted:  boolean  (true only when bytes were removed from R2)
 * }
 *
 * PRI-237
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteObject, r2ConfigFromEnv } from "../_shared/r2.ts";
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

  let body: { file_id?: string; hard_delete?: boolean };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, origin);
  }

  const { file_id, hard_delete = false } = body;
  if (!file_id) {
    return errorResponse("Required field: file_id", 400, origin);
  }

  // Fetch file record
  const { data: file, error: fetchError } = await supabase
    .from("order_files")
    .select("id, r2_key, filename, uploaded_by, deleted_at, upload_status")
    .eq("id", file_id)
    .single();

  if (fetchError || !file) {
    return errorResponse("File not found", 404, origin);
  }

  // Fetch caller's profile for role check
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, active")
    .eq("id", user.id)
    .single();

  if (profileError || !profile || !profile.active) {
    return errorResponse("User profile not found or inactive", 403, origin);
  }

  const isAdmin = profile.role === "admin";
  const isSupervisor = profile.role === "supervisor";
  const isUploader = file.uploaded_by === user.id;

  // Only admin, supervisor, or the original uploader may soft-delete
  if (!isAdmin && !isSupervisor && !isUploader) {
    return errorResponse(
      "Only the uploader, a supervisor, or an admin may delete this file",
      403,
      origin,
    );
  }

  // Hard delete is admin-only
  if (hard_delete && !isAdmin) {
    return errorResponse("Only admins may perform a hard delete", 403, origin);
  }

  // Idempotent: already soft-deleted
  if (file.deleted_at && !hard_delete) {
    return jsonResponse(
      { file_id: file.id, soft_deleted: true, hard_deleted: false },
      200,
      origin,
    );
  }

  // Soft-delete: set deleted_at timestamp
  const { error: updateError } = await supabase
    .from("order_files")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", file_id);

  if (updateError) {
    console.error("DB soft-delete error:", updateError);
    return errorResponse("Failed to soft-delete file", 500, origin);
  }

  // Hard delete from R2 (admin explicit request only)
  let hardDeleted = false;
  if (hard_delete && isAdmin) {
    try {
      const r2Config = r2ConfigFromEnv();
      await deleteObject(r2Config, { key: file.r2_key });
      hardDeleted = true;
    } catch (err) {
      // Log but don't fail — the DB record is already soft-deleted.
      // The scheduled cleanup job will retry R2 deletion.
      console.error("R2 hard delete error (non-fatal, DB already soft-deleted):", err);
    }
  }

  return jsonResponse(
    {
      file_id: file.id,
      soft_deleted: true,
      hard_deleted: hardDeleted,
    },
    200,
    origin,
  );
});
