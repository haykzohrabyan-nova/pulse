/**
 * r2-client.js — Frontend helper for Pulse R2 file storage
 *
 * Wraps the four Supabase Edge Functions that handle R2 presigned URLs.
 * All secrets stay server-side. This module only ever talks to the Edge
 * Functions, never directly to R2 or Cloudflare.
 *
 * Usage:
 *   import { uploadFile, downloadFile, deleteFile } from './r2-client.js';
 *
 *   // Upload
 *   const result = await uploadFile({
 *     supabaseClient,
 *     orderId: 'uuid',
 *     file: fileInputElement.files[0],
 *     category: 'artwork',
 *     onProgress: (pct) => console.log(pct + '%'),
 *   });
 *
 *   // Download (returns a blob URL)
 *   const { blobUrl, filename } = await downloadFile({ supabaseClient, fileId: 'uuid' });
 *
 *   // Soft-delete
 *   await deleteFile({ supabaseClient, fileId: 'uuid' });
 *
 * PRI-237: R2 private file storage + signed upload/download flow
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/** Extensions accepted by the server-side allow-list (mirror of r2.ts) */
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.ai', '.eps', '.png', '.jpg', '.jpeg',
  '.tif', '.tiff', '.psd', '.heic', '.mp4',
]);

const VALID_CATEGORIES = new Set([
  'artwork', 'proof', 'prepress', 'qc', 'shipping', 'other',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get the Supabase Edge Function base URL from the Supabase client.
 * Works with supabase-js v2 (uses client.functionsUrl or constructs it).
 */
function getFunctionsUrl(supabaseClient) {
  // supabase-js v2 exposes supabaseUrl on the client
  const url = supabaseClient.supabaseUrl ?? supabaseClient.rest?.url;
  if (!url) {
    throw new Error('Cannot determine Supabase project URL from client');
  }
  // Convert "https://xyz.supabase.co" → "https://xyz.supabase.co/functions/v1"
  return url.replace(/\/$/, '') + '/functions/v1';
}

/** Get the current user's JWT from the Supabase session */
async function getToken(supabaseClient) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated — no active Supabase session');
  }
  return session.access_token;
}

/** POST to an Edge Function with the user's JWT */
async function callEdgeFunction(supabaseClient, functionName, body) {
  const token = await getToken(supabaseClient);
  const functionsUrl = getFunctionsUrl(supabaseClient);
  const url = `${functionsUrl}/${functionName}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (!resp.ok) {
    throw new R2ClientError(json.error ?? `Edge Function error: HTTP ${resp.status}`, resp.status);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class R2ClientError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'R2ClientError';
    this.statusCode = statusCode ?? null;
  }
}

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

/**
 * Validate a File object before sending to the server.
 * Throws R2ClientError with a user-readable message on failure.
 */
export function validateFile(file) {
  if (!(file instanceof File)) {
    throw new R2ClientError('Expected a File object');
  }
  if (file.size === 0) {
    throw new R2ClientError('Cannot upload an empty file');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    const gb = (file.size / (1024 ** 3)).toFixed(2);
    throw new R2ClientError(`File is ${gb} GB — maximum allowed size is 5 GB`);
  }
  const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new R2ClientError(
      `File type "${ext}" is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}`
    );
  }
}

// ---------------------------------------------------------------------------
// uploadFile
// ---------------------------------------------------------------------------

/**
 * Upload a file to R2 via presigned URL.
 *
 * Steps:
 *  1. Validate file client-side
 *  2. Request presigned PUT URL from r2-presign-upload Edge Function
 *  3. PUT the file bytes directly to R2 (with progress)
 *  4. Confirm upload via r2-confirm-upload Edge Function
 *
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string}   opts.orderId    Supabase orders.id (UUID)
 * @param {File}     opts.file       The file to upload
 * @param {string}   opts.category   file_category enum value
 * @param {string}   [opts.notes]    Optional notes stored in DB
 * @param {Function} [opts.onProgress]  Called with (percentComplete: number) during upload
 *
 * @returns {Promise<{
 *   fileId: string,
 *   r2Key: string,
 *   filename: string,
 *   category: string,
 *   sizeBytes: number,
 * }>}
 */
export async function uploadFile({ supabaseClient, orderId, file, category, notes, onProgress }) {
  if (!supabaseClient) throw new R2ClientError('supabaseClient is required');
  if (!orderId) throw new R2ClientError('orderId is required');
  if (!VALID_CATEGORIES.has(category)) {
    throw new R2ClientError(`Invalid category "${category}". Must be one of: ${[...VALID_CATEGORIES].join(', ')}`);
  }

  // Client-side pre-validation (fast fail before network round-trip)
  validateFile(file);

  // Step 1: Get presigned PUT URL
  const presignData = await callEdgeFunction(supabaseClient, 'r2-presign-upload', {
    order_id: orderId,
    filename: file.name,
    category,
    content_type: file.type || 'application/octet-stream',
    size_bytes: file.size,
    notes: notes ?? null,
  });

  const { file_id, presigned_url, r2_key } = presignData;

  // Step 2: PUT file bytes directly to R2 (with progress via XMLHttpRequest)
  await putToR2(presigned_url, file, file.type || 'application/octet-stream', onProgress);

  // Step 3: Confirm upload in DB
  await callEdgeFunction(supabaseClient, 'r2-confirm-upload', { file_id });

  return {
    fileId: file_id,
    r2Key: r2_key,
    filename: file.name,
    category,
    sizeBytes: file.size,
  };
}

/**
 * PUT file bytes to a presigned R2 URL.
 * Uses XMLHttpRequest for upload progress events.
 */
function putToR2(presignedUrl, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', presignedUrl);
    xhr.setRequestHeader('Content-Type', contentType);

    if (typeof onProgress === 'function') {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new R2ClientError(`R2 upload failed: HTTP ${xhr.status}`, xhr.status));
      }
    });

    xhr.addEventListener('error', () => {
      reject(new R2ClientError('R2 upload failed: network error'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new R2ClientError('R2 upload timed out'));
    });

    xhr.timeout = 60 * 60 * 1000; // 1 hour — allow time for large files
    xhr.send(file);
  });
}

// ---------------------------------------------------------------------------
// downloadFile
// ---------------------------------------------------------------------------

/**
 * Download a file from R2 via presigned GET URL.
 * Returns a blob URL that can be used as an <a> href or <img> src.
 * The blob URL is valid until you call URL.revokeObjectURL() or the page unloads.
 *
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string} opts.fileId   UUID of the order_files row
 *
 * @returns {Promise<{ blobUrl: string, filename: string, contentType: string, sizeBytes: number }>}
 */
export async function downloadFile({ supabaseClient, fileId }) {
  if (!supabaseClient) throw new R2ClientError('supabaseClient is required');
  if (!fileId) throw new R2ClientError('fileId is required');

  const { presigned_url, filename, content_type, size_bytes } = await callEdgeFunction(
    supabaseClient,
    'r2-presign-download',
    { file_id: fileId },
  );

  const resp = await fetch(presigned_url);
  if (!resp.ok) {
    throw new R2ClientError(`Failed to fetch file from R2: HTTP ${resp.status}`, resp.status);
  }

  const blob = await resp.blob();
  const blobUrl = URL.createObjectURL(blob);

  return { blobUrl, filename, contentType: content_type, sizeBytes: size_bytes };
}

/**
 * Trigger a browser download for a file from R2.
 * Creates a temporary <a> tag, clicks it, then cleans up.
 *
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string} opts.fileId
 */
export async function triggerDownload({ supabaseClient, fileId }) {
  const { blobUrl, filename } = await downloadFile({ supabaseClient, fileId });
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick to ensure the download starts
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

// ---------------------------------------------------------------------------
// deleteFile
// ---------------------------------------------------------------------------

/**
 * Soft-delete a file (hides it from all UI; bytes retained for 30 days).
 * Admins may pass `hardDelete: true` to immediately remove bytes from R2.
 *
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string}  opts.fileId
 * @param {boolean} [opts.hardDelete=false]  Admin only — removes bytes from R2 immediately
 *
 * @returns {Promise<{ fileId: string, softDeleted: boolean, hardDeleted: boolean }>}
 */
export async function deleteFile({ supabaseClient, fileId, hardDelete = false }) {
  if (!supabaseClient) throw new R2ClientError('supabaseClient is required');
  if (!fileId) throw new R2ClientError('fileId is required');

  const result = await callEdgeFunction(supabaseClient, 'r2-delete', {
    file_id: fileId,
    hard_delete: hardDelete,
  });

  return {
    fileId: result.file_id,
    softDeleted: result.soft_deleted,
    hardDeleted: result.hard_deleted,
  };
}

// ---------------------------------------------------------------------------
// getFileList
// ---------------------------------------------------------------------------

/**
 * Fetch metadata for all active files attached to an order.
 * Uses the Supabase client directly (RLS enforces access).
 * Does NOT include presigned URLs — call downloadFile() per file to get those.
 *
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabaseClient
 * @param {string} opts.orderId
 * @param {string} [opts.category]  Filter by category
 *
 * @returns {Promise<Array<{
 *   id: string,
 *   filename: string,
 *   category: string,
 *   contentType: string,
 *   sizeBytes: number,
 *   uploadedBy: string,
 *   notes: string|null,
 *   createdAt: string,
 * }>>}
 */
export async function getFileList({ supabaseClient, orderId, category }) {
  if (!supabaseClient) throw new R2ClientError('supabaseClient is required');
  if (!orderId) throw new R2ClientError('orderId is required');

  let query = supabaseClient
    .from('order_files')
    .select('id, filename, category, content_type, size_bytes, uploaded_by, notes, created_at')
    .eq('order_id', orderId)
    .eq('upload_status', 'complete')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (category) {
    query = query.eq('category', category);
  }

  const { data, error } = await query;
  if (error) {
    throw new R2ClientError(`Failed to fetch file list: ${error.message}`);
  }

  return (data ?? []).map((f) => ({
    id: f.id,
    filename: f.filename,
    category: f.category,
    contentType: f.content_type,
    sizeBytes: f.size_bytes,
    uploadedBy: f.uploaded_by,
    notes: f.notes,
    createdAt: f.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Utility: human-readable file size
// ---------------------------------------------------------------------------

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
