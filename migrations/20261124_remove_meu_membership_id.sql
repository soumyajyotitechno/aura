BEGIN;

-- Run only after the external-id code is deployed. The additive external_id migration
-- must already have completed successfully.

-- The live code has already stopped reading/writing these columns before this migration runs.
ALTER TABLE public.meu_member_linking
  DROP COLUMN IF EXISTS membership_id;

ALTER TABLE public.meu_log
  DROP COLUMN IF EXISTS membership_id;

-- Each partner's me&u transaction table keeps membership_external_id, which is the Aura external id.
DO $$
DECLARE
  row_record record;
BEGIN
  FOR row_record IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'membership_id'
      AND table_name LIKE 'meu\_%\_transactions' ESCAPE E'\\'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP COLUMN IF EXISTS membership_id',
      row_record.table_schema,
      row_record.table_name
    );
  END LOOP;
END $$;

COMMIT;
