-- Audit log, partitioned monthly from day one (ARCHITECTURE.md I30).
-- Partition creation for future months is handled by src/core/audit.ts ensureAuditPartition().

CREATE TABLE audit_log (
  namespace_id      uuid NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  seq               bigint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  actor_agent_id    uuid NOT NULL REFERENCES agents(id),
  request_id        uuid NOT NULL,
  plane             text NOT NULL CHECK (plane IN ('control','data')),
  kind              text NOT NULL,
  payload           jsonb NOT NULL,
  prev_hash         bytea NOT NULL,
  chain_hash        bytea NOT NULL,
  PRIMARY KEY (namespace_id, seq, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX audit_log_ns_seq ON audit_log(namespace_id, seq);
CREATE INDEX audit_log_actor   ON audit_log(actor_agent_id);
CREATE INDEX audit_log_request ON audit_log(request_id);

-- Namespace audit head — cached current (seq, chain_hash) for O(1) next-entry computation
-- and external anchoring via audit.head.
CREATE TABLE audit_heads (
  namespace_id      uuid PRIMARY KEY REFERENCES namespaces(id) ON DELETE CASCADE,
  seq               bigint NOT NULL,
  chain_hash        bytea NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Create initial partitions: previous, current, next month. Future months added on boot.
DO $$
DECLARE
  month_start date;
  month_end   date;
  part_name   text;
  i           int;
BEGIN
  FOR i IN -1..1 LOOP
    month_start := date_trunc('month', now() + (i || ' month')::interval)::date;
    month_end   := (month_start + interval '1 month')::date;
    part_name   := 'audit_log_' || to_char(month_start, 'YYYY_MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      part_name, month_start, month_end
    );
  END LOOP;
END
$$;
