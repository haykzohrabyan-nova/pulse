-- Street / mailing line for each facility (organisation.html).
ALTER TABLE public.organisation_facilities
  ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
