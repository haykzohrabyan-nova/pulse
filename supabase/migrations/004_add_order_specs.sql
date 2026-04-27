-- =============================================================================
-- PRI-239: Migration 004 — Add specs JSONB column to orders
-- Purpose: Store all flexible product fields that don't have explicit columns
--          (dimensions, finishing details, skus, artwork metadata, billing, etc.)
-- Applied to: Supabase/Postgres (project: pulse.bazaar-admin.com)
-- Generated: 2026-04-27
-- =============================================================================

-- Add the specs column — non-destructive, defaults to empty object
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '{}';

-- Add a GIN index for efficient JSONB queries (e.g. searching by parentOrderId)
CREATE INDEX IF NOT EXISTS orders_specs_gin_idx ON orders USING GIN (specs);

-- Add parent_order_id as a generated column for fast sub-ticket lookups
-- (extracted from specs->>'parentOrderId')
-- Note: This is a regular column updated by the application layer, not a generated column,
-- because generated columns cannot reference JSONB subfields in Postgres without a function.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS parent_order_id TEXT;

CREATE INDEX IF NOT EXISTS orders_parent_order_id_idx ON orders(parent_order_id);

-- =============================================================================
-- specs JSONB field inventory (what the app stores here)
-- =============================================================================
-- jobDescription        TEXT    — free text job description
-- otherProductDesc      TEXT    — when product_type = 'Other'
-- labelWidth            NUMERIC — in inches
-- labelHeight           NUMERIC — in inches
-- boxDepth              NUMERIC — in inches (box products)
-- pouchGusset           NUMERIC — in inches (pouch products)
-- rollDirection         TEXT    — roll direction value
-- customBatching        BOOL    — custom batching enabled
-- unitsPerRoll          INT     — when customBatching=true and printType=Roll
-- packagingInstructions TEXT    — custom packaging notes
-- hasSpecialColor       BOOL
-- specialColorDetails   TEXT
-- hasPerforation        BOOL
-- perforationNotes      TEXT
-- finishingNotes        TEXT
-- applicationService    BOOL
-- applicationContainerType TEXT
-- applicationFeePerPiece   NUMERIC
-- cutMethod             TEXT
-- dieName               TEXT
-- extraFrames           INT
-- makeReadyFrames       INT
-- framesWasted          INT
-- skus                  JSONB[] — SKU list for multi-SKU jobs
-- skuCount              INT
-- artworkFiles          JSONB[] — file metadata (R2 keys in order_files table, PRI-237)
-- customerPO            TEXT
-- quoteRef              TEXT
-- pricePerUnit          NUMERIC
-- orderTotal            NUMERIC
-- paymentTerms          TEXT
-- invoiceNumber         TEXT
-- invoiceStatus         TEXT
-- parentOrderId         TEXT    — parent ticket orderId (also mirrored to parent_order_id col)
-- capacityOverride      BOOL
-- capacityDetails       JSONB
-- needsConfirmation     BOOL
-- confirmationReason    TEXT
-- noteType              TEXT    — INFO | ALERT | WARNING
-- specialNotes          TEXT
-- rushApprovedAt        TIMESTAMPTZ
-- hasWhiteLayer         BOOL
-- hasFoil               BOOL
-- foilNotes             TEXT
-- holdApprovals         JSONB
-- holdRequestedAt       TIMESTAMPTZ
-- needsAccountManagerAction BOOL
-- prepressResubmittedAt     TIMESTAMPTZ
-- prepressResubmittedBy     TEXT
-- overtimeApproval      JSONB
-- notesLog              JSONB[] — legacy notes/conversation history (migrated from IndexedDB)
-- conversationHistory   JSONB[] — same as notesLog, preserved for compatibility
-- =============================================================================
