-- Abel's role was changed to 'prepress' in Admin → Personnel, but
-- the update only wrote to config.personnel (JSON blob), not the
-- profiles table. At login, profiles.role still read 'operator',
-- redirecting Abel to operator-terminal instead of prepress.
--
-- Fix: set profiles.role = 'prepress' for Abel's account.

UPDATE public.profiles p
SET    role = 'prepress'
FROM   auth.users u
WHERE  u.email = 'abel@bazaar-admin.com'
  AND  p.id    = u.id;
