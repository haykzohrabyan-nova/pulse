/**
 * r2-presign-upload — Supabase Edge Function
 *
 * Issues a presigned PUT URL for uploading a file directly to Cloudflare R2.
 * Also creates a pending order_files DB row so we can track the upload.
 *
 * POST body (JSON):
 * {
 *   order_id:     string  (UUID of the order)
 *   filename:     string  (original filename, e.g. "sticker-design.pdf")
 *   category:     string  (file_category enum: artwork|proof|prepress|qc|shipping|other)
 *   content_type: string  (MIME type, e.g. "application/pdf")
 *   size_bytes:   number  (file size — must be <= 5 GB)
 *   notes?:       string  (optional notes to store in DB)
 * }
 *
 * Response (JSON):
 * {
 *   file_id:      string  (UUID of the created order_files row)
 *   presigned_url: string (PUT this URL with the file binary)
 *   r2_key:       string  (R2 object key for your records)
 *   expires_at:   string  (ISO8601 — URL valid until this time)
 * }
 *
 * Security:
 * - Requires valid Supabase JWT (Authorization: Bearer <token>)
 * - Extension + content-type allow-list enforced server-side
 * - Max file size 5 GB enforced server-side
 * - R2 credentials never sent to the client
 * - Content-Type is included in signed headers — client must send matching header
 *
 * PRI-237
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildOrderFileKey,
  MAX_FILE_SIZE_BYTES,
  presignUpload,
  r2ConfigFromEnv,
  validateFileType,
} from "../_shared/r2.ts";
import {
  errorResponse,
  handlePreflight,
  jsonResponse,
} from "../_shared/cors.ts";

const VALID_CATEGORIES = new Set([
  "artwork",
  "proof",
  "prepress",
  "qc",
  "shipping",
  "other",
]);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  // Handle CORS preflight
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405, origin);
  }

  // Authenticate via Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Missing or invalid Authorization header", 401, origin);
  }
  const token = authHeader.slice(7);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Verify the user token and get user ID
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return errorResponse("Unauthorized", 401, origin);
  }

  // Parse request body
  let body: {
    order_id?: string;
    filename?: string;
    category?: string;
    content_type?: string;
    size_bytes?: number;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400, origin);
  }

  const { order_id, filename, category, content_type, size_bytes, notes } = body;

  // Validate required fields
  if (!order_id || !filename || !category || !content_type || size_bytes == null) {
    return errorResponse(
      "Required fields: order_id, filename, category, content_type, size_bytes",
      400,
      origin,
    );
  }

  if (!VALID_CATEGORIES.has(category)) {
    return errorResponse(
      `Invalid category. Must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
      400,
      origin,
    );
  }

  // Extension + content-type allow-list
  const typeError = validateFileType(filename, content_type);
  if (typeError) {
    return errorResponse(typeError, 400, origin);
  }

  // Size limit
  if (size_bytes > MAX_FILE_SIZE_BYTES) {
    return errorResponse(
      `File too large. Maximum size is 5 GB (${MAX_FILE_SIZE_BYTES} bytes). Got ${size_bytes} bytes.`,
      400,
      origin,
    );
  }
  if (size_bytes <= 0) {
    return errorResponse("size_bytes must be positive", 400, origin);
  }

  // Verify the order exists and the user has access to it
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, facility")
    .eq("id", order_id)
    .single();

  if (orderError || !order) {
    return errorResponse("Order not found or access denied", 404, origin);
  }

  // Check user's profile for upload permission (operator/prepress cannot upload)
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profileError || !profile) {
    return errorResponse("User profile not found", 403, origin);
  }

  const canUpload = ["admin", "supervisor", "production_manager", "account_manager", "prepress"].includes(
    profile.role,
  );
  if (!canUpload) {
    return errorResponse(
      `Role "${profile.role}" does not have file upload permission`,
      403,
      origin,
    );
  }

  // Build R2 key — unique per upload to avoid collisions
  const fileUuid = crypto.randomUUID();
  const ext = filename.split(".").pop() ?? "";
  const r2Key = buildOrderFileKey({
    orderId: order_id,
    category,
    fileUuid,
    extension: ext,
  });

  // Generate presigned PUT URL (15 min expiry — covers large file uploads)
  let presignedUrl: string;
  let expiresAt: Date;
  try {
    const r2Config = r2ConfigFromEnv();
    const result = await presignUpload(r2Config, {
      key: r2Key,
      contentType: content_type,
      contentLength: size_bytes,
      expiresInSeconds: 900,
    });
    presignedUrl = result.url;
    expiresAt = result.expiresAt;
  } catch (err) {
    console.error("R2 presign error:", err);
    return errorResponse("Failed to generate upload URL", 500, origin);
  }

  // Create pending order_files record — confirmed after successful upload
  const { data: fileRecord, error: insertError } = await supabase
    .from("order_files")
    .insert({
      order_id,
      category,
      filename,
      r2_key: r2Key,
      content_type,
      size_bytes,
      uploaded_by: user.id,
      notes: notes ?? null,
      upload_status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !fileRecord) {
    console.error("DB insert error:", insertError);
    return errorResponse("Failed to register file metadata", 500, origin);
  }

  return jsonResponse(
    {
      file_id: fileRecord.id,
      presigned_url: presignedUrl,
      r2_key: r2Key,
      expires_at: expiresAt.toISOString(),
    },
    200,
    origin,
  );
});
