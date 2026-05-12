-- Facility manager (chosen from profiles) for organisation.html.
-- Set NULL on profile delete so the facility row survives.

ALTER TABLE public.organisation_facilities
  ADD COLUMN IF NOT EXISTS manager_id UUID
    REFERENCES public.profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS organisation_facilities_manager_idx
  ON public.organisation_facilities(manager_id);
