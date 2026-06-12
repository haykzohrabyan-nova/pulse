-- Organisation tables (017+) need explicit grants if 028 ran before 017 or grants were reset.
-- Without these, authenticated users see: permission denied for table organisations (42501).

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organisations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organisation_facilities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organisation_hardware TO authenticated;
