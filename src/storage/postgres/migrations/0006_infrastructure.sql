-- Cross-cutting infrastructure: idempotency, rate limiting, system state.

CREATE TABLE idempotency (
  agent_id          uuid NOT NULL REFERENCES agents(id),
  key               text NOT NULL,
  result            jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (agent_id, key)
);

CREATE INDEX idempotency_expires ON idempotency(expires_at);

-- Rate limit buckets, one row per (agent, second-window).
-- Purged by a background task; old rows do no harm while present.
CREATE TABLE rate_buckets (
  agent_id          uuid NOT NULL REFERENCES agents(id),
  window_second     bigint NOT NULL,
  cost_consumed     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, window_second)
);

CREATE INDEX rate_buckets_window ON rate_buckets(window_second);

CREATE TABLE system_state (
  key               text PRIMARY KEY,
  value             jsonb NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
