-- PM workflow machine swap audit log (product workflow config)

CREATE TABLE IF NOT EXISTS workflow_override_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  step_index          INTEGER NOT NULL,
  original_machine_id TEXT,
  new_machine_id    TEXT,
  original_machine    TEXT,
  new_machine         TEXT NOT NULL,
  changed_by          TEXT,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason              TEXT
);

CREATE INDEX workflow_override_log_order_id_idx ON workflow_override_log(order_id);
CREATE INDEX workflow_override_log_changed_at_idx ON workflow_override_log(changed_at DESC);

ALTER TABLE workflow_override_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_override_log_select"
  ON workflow_override_log FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "workflow_override_log_insert"
  ON workflow_override_log FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);
