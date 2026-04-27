-- ---------------------------------------------------------------------------
-- Migration 005: R2 file tracking — upload_status + soft-delete
-- PRI-237: Cloudflare R2 private file storage + signed upload/download flow
-- ---------------------------------------------------------------------------

-- Track whether the actual R2 upload completed
ALTER TABLE order_files
  ADD COLUMN upload_status TEXT NOT NULL DEFAULT 'complete'
    CHECK (upload_status IN ('pending', 'complete', 'failed')),
  ADD COLUMN deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN order_files.upload_status IS
  'pending = presigned URL issued but upload not yet confirmed; '
  'complete = bytes confirmed in R2; failed = upload did not finish';

COMMENT ON COLUMN order_files.deleted_at IS
  'Soft delete timestamp. File is hidden from all UI. '
  'Admin may hard-delete from R2 after 30-day retention window.';

-- Index for fast filtering of active (non-deleted, complete) files
CREATE INDEX order_files_active_idx
  ON order_files(order_id, category)
  WHERE deleted_at IS NULL AND upload_status = 'complete';

-- Index for cleanup job: find stale pending records
CREATE INDEX order_files_pending_idx
  ON order_files(created_at)
  WHERE upload_status = 'pending';

-- ---------------------------------------------------------------------------
-- Update RLS so deleted / pending files are invisible to non-admins
-- ---------------------------------------------------------------------------

-- Drop existing read policies on order_files (re-created below with filter)
DROP POLICY IF EXISTS "order_files_read" ON order_files;

-- All authenticated users with order access may read active, complete files
CREATE POLICY "order_files_read_active"
  ON order_files FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND deleted_at IS NULL
    AND upload_status = 'complete'
  );

-- Admins may see all files including deleted/pending
CREATE POLICY "order_files_admin_read_all"
  ON order_files FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- Scheduled cleanup function: hard-delete stale pending uploads (> 2 hours)
-- Call via pg_cron or a scheduled Edge Function
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cleanup_stale_pending_uploads()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM order_files
  WHERE upload_status = 'pending'
    AND created_at < NOW() - INTERVAL '2 hours'
  ;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_stale_pending_uploads IS
  'Remove order_files rows where the upload never completed (pending > 2h). '
  'The corresponding R2 object was never written, so no R2 deletion needed. '
  'Schedule via pg_cron: SELECT cron.schedule(''cleanup-pending-uploads'', ''0 * * * *'', $$SELECT cleanup_stale_pending_uploads()$$);';
