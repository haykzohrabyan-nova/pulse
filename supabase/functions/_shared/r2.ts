/**
 * Cloudflare R2 presigned URL utility for Supabase Edge Functions (Deno).
 *
 * R2 is S3-compatible, so we use AWS Signature Version 4.
 * No external dependencies — uses the Web Crypto API built into Deno.
 *
 * PRI-237: R2 private file storage + signed upload/download flow
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface R2Config {
  /** Cloudflare Account ID (from R2 dashboard) */
  accountId: string;
  /** R2 bucket name */
  bucket: string;
  /** R2 Access Key ID */
  accessKeyId: string;
  /** R2 Secret Access Key */
  secretAccessKey: string;
}

export interface PresignUploadOptions {
  /** R2 object key, e.g. "orders/uuid/artwork/uuid.pdf" */
  key: string;
  /** MIME type of the file — will be included in signed headers */
  contentType: string;
  /** File size in bytes — used for Content-Length header signing */
  contentLength: number;
  /** URL expiry in seconds (default 900 = 15 min — long enough for 5 GB uploads) */
  expiresInSeconds?: number;
}

export interface PresignDownloadOptions {
  /** R2 object key */
  key: string;
  /** URL expiry in seconds (default 3600 = 1 hour) */
  expiresInSeconds?: number;
}

export interface PresignDeleteOptions {
  /** R2 object key */
  key: string;
}

// ---------------------------------------------------------------------------
// Key naming convention
// ---------------------------------------------------------------------------

/**
 * Build the canonical R2 key for an order file.
 * Pattern: orders/{order_uuid}/{category}/{file_uuid}{ext}
 *
 * - order_uuid: Supabase orders.id
 * - category:   file_category enum value
 * - file_uuid:  freshly generated UUID per upload request
 * - ext:        lowercased original extension (e.g. ".pdf")
 */
export function buildOrderFileKey(params: {
  orderId: string;
  category: string;
  fileUuid: string;
  extension: string;
}): string {
  const ext = params.extension.toLowerCase().replace(/^\.?/, ".");
  return `orders/${params.orderId}/${params.category}/${params.fileUuid}${ext}`;
}

// ---------------------------------------------------------------------------
// Allowed extensions + content type map (server-side allow-list)
// ---------------------------------------------------------------------------

/** Map from normalised extension → accepted MIME types */
export const ALLOWED_TYPES: Record<string, string[]> = {
  ".pdf": ["application/pdf"],
  ".ai": ["application/postscript", "application/illustrator", "application/x-illustrator"],
  ".eps": ["application/postscript", "application/eps", "image/x-eps"],
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".tif": ["image/tiff"],
  ".tiff": ["image/tiff"],
  ".psd": ["image/vnd.adobe.photoshop", "image/x-photoshop", "application/x-photoshop"],
  ".heic": ["image/heic", "image/heif"],
  ".mp4": ["video/mp4"],
};

export const ALLOWED_EXTENSIONS = new Set(Object.keys(ALLOWED_TYPES));

/** Maximum upload size: 5 GB */
export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5_368_709_120

/**
 * Validate a filename + content_type against the allow-list.
 * Returns an error string or null if valid.
 */
export function validateFileType(filename: string, contentType: string): string | null {
  const ext = ("." + filename.split(".").pop()!).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return `File extension "${ext}" is not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`;
  }
  const allowed = ALLOWED_TYPES[ext];
  const normalised = contentType.split(";")[0].trim().toLowerCase();
  if (!allowed.includes(normalised)) {
    return `Content-Type "${contentType}" does not match extension "${ext}". Expected one of: ${allowed.join(", ")}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Low-level crypto helpers
// ---------------------------------------------------------------------------

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(data),
  );
  return toHex(hash);
}

// ---------------------------------------------------------------------------
// SigV4 presigned URL builder
// ---------------------------------------------------------------------------

/**
 * Sign a query string for an R2 presigned URL using AWS Signature Version 4.
 *
 * R2 specifics:
 * - region: "auto"
 * - service: "s3"
 * - host: "{accountId}.r2.cloudflarestorage.com"
 * - endpoint: "https://{host}/{bucket}/{key}"
 * - payload hash: "UNSIGNED-PAYLOAD" (standard for presigned object URLs)
 */
async function buildPresignedUrl(
  config: R2Config,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  expiresInSeconds: number,
  extraSignedHeaders: Record<string, string> = {},
): Promise<string> {
  const region = "auto";
  const service = "s3";
  const host = `${config.accountId}.r2.cloudflarestorage.com`;

  // Timestamps
  const now = new Date();
  const dateTime = now.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z"; // YYYYMMDDTHHMMSSZ
  const dateOnly = dateTime.slice(0, 8); // YYYYMMDD

  // Credential scope
  const credentialScope = `${dateOnly}/${region}/${service}/aws4_request`;

  // Signed headers — always include host; extra headers (e.g. content-type for PUT)
  const allSignedHeaders: Record<string, string> = {
    host,
    ...extraSignedHeaders,
  };
  const signedHeaderNames = Object.keys(allSignedHeaders)
    .map((h) => h.toLowerCase())
    .sort()
    .join(";");

  // Canonical path: each segment is URI-encoded; slashes between segments are preserved
  const canonicalPath = "/" + config.bucket + "/" +
    key.split("/").map((seg) => encodeURIComponent(seg)).join("/");

  // Query string params for presigning (sorted alphabetically by key)
  const queryParams: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${config.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", dateTime],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaderNames],
  ];
  // Sort by encoded key name
  queryParams.sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  // Canonical headers (sorted lowercase name: value\n)
  const canonicalHeaders = Object.entries(allSignedHeaders)
    .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}`)
    .sort()
    .join("\n") + "\n";

  // Canonical request
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaderNames,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  // Signing key (HMAC chain)
  let signingKey: ArrayBuffer = new TextEncoder().encode(
    `AWS4${config.secretAccessKey}`,
  );
  for (const part of [dateOnly, region, service, "aws4_request"]) {
    signingKey = await hmacSha256(signingKey, part);
  }

  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  // Build final URL
  const url = `https://${host}${canonicalPath}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  return url;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a presigned PUT URL for uploading a file to R2.
 * The URL expires in `expiresInSeconds` (default 900 s = 15 min).
 * Content-Type is included in the signed headers — the client MUST send the
 * exact same Content-Type header in the PUT request.
 */
export async function presignUpload(
  config: R2Config,
  opts: PresignUploadOptions,
): Promise<{ url: string; expiresAt: Date }> {
  const expiresIn = opts.expiresInSeconds ?? 900;
  const url = await buildPresignedUrl(
    config,
    "PUT",
    opts.key,
    expiresIn,
    { "content-type": opts.contentType },
  );
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return { url, expiresAt };
}

/**
 * Generate a presigned GET URL for downloading a file from R2.
 * Expires in `expiresInSeconds` (default 3600 s = 1 hour).
 */
export async function presignDownload(
  config: R2Config,
  opts: PresignDownloadOptions,
): Promise<{ url: string; expiresAt: Date }> {
  const expiresIn = opts.expiresInSeconds ?? 3600;
  const url = await buildPresignedUrl(config, "GET", opts.key, expiresIn);
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  return { url, expiresAt };
}

/**
 * Hard-delete an object from R2 using the S3-compatible DELETE API.
 * Called server-side only (never from the browser).
 */
export async function deleteObject(
  config: R2Config,
  opts: PresignDeleteOptions,
): Promise<void> {
  const region = "auto";
  const service = "s3";
  const host = `${config.accountId}.r2.cloudflarestorage.com`;

  const now = new Date();
  const dateTime = now.toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
  const dateOnly = dateTime.slice(0, 8);

  const credentialScope = `${dateOnly}/${region}/${service}/aws4_request`;
  const canonicalPath = "/" + config.bucket + "/" +
    opts.key.split("/").map((seg) => encodeURIComponent(seg)).join("/");

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:${dateTime}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    "DELETE",
    canonicalPath,
    "", // empty query string
    canonicalHeaders,
    signedHeaders,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", // SHA256 of empty body
  ].join("\n");

  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    dateTime,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  let signingKey: ArrayBuffer = new TextEncoder().encode(
    `AWS4${config.secretAccessKey}`,
  );
  for (const part of [dateOnly, region, service, "aws4_request"]) {
    signingKey = await hmacSha256(signingKey, part);
  }
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const endpoint = `https://${host}${canonicalPath}`;
  const resp = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: authHeader,
      "x-amz-date": dateTime,
      "x-amz-content-sha256":
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  });

  if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
    const body = await resp.text();
    throw new Error(`R2 DELETE failed: HTTP ${resp.status} — ${body}`);
  }
}

/**
 * Load R2 config from Edge Function environment variables.
 * Required env vars:
 *   R2_ACCOUNT_ID
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET_NAME
 */
export function r2ConfigFromEnv(): R2Config {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET_NAME");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing required R2 environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME",
    );
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}
