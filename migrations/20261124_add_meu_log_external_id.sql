-- Run before deploying the external-id code. This is additive and safe for the old code.
ALTER TABLE public.meu_log
  ADD COLUMN IF NOT EXISTS external_id VARCHAR(100);
