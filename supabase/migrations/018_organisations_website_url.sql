-- Optional public website for the organisation profile (organisation.html).
ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS website_url TEXT;
