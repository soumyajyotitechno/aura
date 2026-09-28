CREATE TABLE meu_link_status_log (
  id            BIGSERIAL PRIMARY KEY,
  event_type    VARCHAR(50)  NOT NULL,   -- e.g. 'MEU_AUTO_LINKING', 'MEU_MEMBERSHIP_LINKING', 'MEU_WEBHOOK'
  status        VARCHAR(20)  NOT NULL,   -- 'SAVED', 'NOT_SAVED', 'ERROR'
  program_id    VARCHAR(100),
  external_id   VARCHAR(100),
  membership_id VARCHAR(100),
  member_id     UUID,
  message       TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meu_link_status_log_event_status ON meu_link_status_log (event_type, status);
CREATE INDEX idx_meu_link_status_log_created_at ON meu_link_status_log (created_at);
