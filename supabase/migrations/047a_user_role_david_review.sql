-- STEP 1 of 2 — Run this ALONE in Supabase SQL Editor, then run 047b.
--
-- PostgreSQL requires new enum values to COMMIT before they can be used.
-- Do NOT combine this file with 047b in one Run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'david_review'
  ) THEN
    ALTER TYPE public.user_role ADD VALUE 'david_review';
  END IF;
END $$;

-- Confirm (optional):
SELECT e.enumlabel AS user_role_value
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname = 'user_role' AND e.enumlabel = 'david_review';
