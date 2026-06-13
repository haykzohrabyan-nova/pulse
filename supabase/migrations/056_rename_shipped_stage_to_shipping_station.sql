-- Dashboard production-line columns: rename legacy stage label "Shipped" → "Shipping Station".
-- pulseProductionLines in config overrides shared.js defaults at runtime.

UPDATE public.config
SET value = replace(value::text, '"Shipped"', '"Shipping Station"')::jsonb,
    updated_at = now()
WHERE key = 'pulseProductionLines'
  AND value::text LIKE '%"Shipped"%';
