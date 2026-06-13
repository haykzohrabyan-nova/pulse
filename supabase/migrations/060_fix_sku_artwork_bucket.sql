-- Fix sku-artwork bucket policies (manager role) and ensure bucket exists.
-- Run in Supabase SQL Editor if 058 was applied with ops_manager or bucket missing.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sku-artwork',
  'sku-artwork',
  TRUE,
  10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "sku_artwork_select_public" ON storage.objects;
DROP POLICY IF EXISTS "sku_artwork_insert_staff" ON storage.objects;
DROP POLICY IF EXISTS "sku_artwork_update_staff" ON storage.objects;
DROP POLICY IF EXISTS "sku_artwork_delete_staff" ON storage.objects;

CREATE POLICY "sku_artwork_select_public"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'sku-artwork');

CREATE POLICY "sku_artwork_insert_staff"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'manager', 'job_manager', 'production_manager',
      'account_manager', 'david_review', 'prepress'
    )
  );

CREATE POLICY "sku_artwork_update_staff"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'manager', 'job_manager', 'production_manager',
      'account_manager', 'david_review', 'prepress'
    )
  );

CREATE POLICY "sku_artwork_delete_staff"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'sku-artwork'
    AND (current_user_role())::text IN (
      'admin', 'supervisor', 'manager', 'job_manager', 'production_manager',
      'account_manager', 'david_review', 'prepress'
    )
  );
