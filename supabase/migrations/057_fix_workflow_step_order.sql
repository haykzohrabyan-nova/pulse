-- Fix workflow step order: print (press) must always come before cut (GM Laser/Die).
-- Affected when product_workflows.steps or order_workflow_steps were saved with cutter first.

-- ── 1. Reset known 6K roll-label product workflow templates ──────────────────

UPDATE public.product_workflows
SET steps = '[
  {"machineId":"press-6k","operation":"Printing","stepType":"default","sortOrder":1,"alternatives":[],"conditionField":null,"conditionOp":null,"conditionValue":null,"defaultMachineId":null,"defaultOperation":null,"notes":null},
  {"machineId":"gm-die-cutter","operation":"Die Cutting","stepType":"conditional","sortOrder":2,"alternatives":[{"machineId":"gm-laser-cutter","operation":"Laser Cutting"}],"defaultMachineId":"gm-laser-cutter","defaultOperation":"Laser Cutting","conditionField":"cutMethod","conditionOp":"equals","conditionValue":"die","notes":null}
]'::jsonb,
    updated_at = NOW()
WHERE product_name ILIKE 'Labels (Roll)'
   OR product_name ILIKE 'Stickers'
   OR product_name ILIKE '%Labels%Roll%';

UPDATE public.product_workflows
SET steps = '[
  {"machineId":"press-6k","operation":"Printing","stepType":"default","sortOrder":1,"alternatives":[],"conditionField":null,"conditionOp":null,"conditionValue":null,"defaultMachineId":null,"defaultOperation":null,"notes":null},
  {"machineId":"gm-die-cutter","operation":"Die Cutting","stepType":"conditional","sortOrder":2,"alternatives":[{"machineId":"gm-laser-cutter","operation":"Laser Cutting"}],"defaultMachineId":"gm-laser-cutter","defaultOperation":"Laser Cutting","conditionField":"cutMethod","conditionOp":"equals","conditionValue":"die","notes":null},
  {"machineId":"karlville","operation":"Pouching","stepType":"default","sortOrder":3,"alternatives":[],"conditionField":null,"conditionOp":null,"conditionValue":null,"defaultMachineId":null,"defaultOperation":null,"notes":null}
]'::jsonb,
    updated_at = NOW()
WHERE product_name ILIKE 'Pouches';

UPDATE public.product_workflows
SET steps = '[
  {"machineId":"press-6k","operation":"Printing","stepType":"default","sortOrder":1,"alternatives":[],"conditionField":null,"conditionOp":null,"conditionValue":null,"defaultMachineId":null,"defaultOperation":null,"notes":null},
  {"machineId":"gm-laser-cutter","operation":"Laser Cutting","stepType":"default","sortOrder":2,"alternatives":[{"machineId":"gm-die-cutter","operation":"Die Cutting"}],"conditionField":null,"conditionOp":null,"conditionValue":null,"defaultMachineId":null,"defaultOperation":null,"notes":null}
]'::jsonb,
    updated_at = NOW()
WHERE product_name ILIKE 'Diecut Stickers'
   OR product_name ILIKE '%Diecut%Sticker%';

-- ── 2. Swap inverted steps on existing orders (cutter step 0, press step 1) ─

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT s0.id AS id0, s1.id AS id1
    FROM public.order_workflow_steps s0
    JOIN public.order_workflow_steps s1
      ON s1.order_id = s0.order_id AND s1.step_index = 1
    WHERE s0.step_index = 0
      AND (
        s0.machine ILIKE '%GM Laser Cutter%'
        OR s0.machine ILIKE '%GM Die Cutter%'
      )
      AND s1.machine ILIKE '%Indigo 6K%'
  LOOP
    UPDATE public.order_workflow_steps SET step_index = -1 WHERE id = r.id0;
    UPDATE public.order_workflow_steps SET step_index = 0  WHERE id = r.id1;
    UPDATE public.order_workflow_steps SET step_index = 1  WHERE id = r.id0;
  END LOOP;
END $$;
