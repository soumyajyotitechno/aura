-- Supports INSERT ... ON CONFLICT (partner_id, member_id).
-- Preserves the existing member_id primary key and all member data.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.meu_member_linking
  ADD CONSTRAINT meu_member_linking_partner_member_key
  UNIQUE (partner_id, member_id);

COMMIT;
