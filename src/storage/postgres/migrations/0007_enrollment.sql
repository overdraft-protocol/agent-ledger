-- Operator-gated enrollment requests.
--
-- An external client posts an enrollment request with a desired oauth_subject;
-- the server returns an opaque enrollment_id and a single-use claim_secret.
-- An operator reviews the request out-of-band (CLI) and either approves it
-- (creating an agents row) or rejects it. The original caller then exchanges
-- their enrollment_id + claim_secret for the agent_id.
--
-- Security:
--   * claim_secret is never stored in plaintext; only a sha256 digest is kept.
--   * claim_secret_hash is sized for sha256 (32 bytes).
--   * Statuses are a closed enum-by-CHECK, transitioned only by control code.
--   * status='claimed' burns the secret (we null the hash) so the same
--     credentials cannot be replayed.
--   * expires_at is enforced by the application (sweep on write); the column
--     is the authoritative source of truth so manual SQL inspection is honest.

CREATE TABLE enrollment_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_subject         text NOT NULL,
  note                  text,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','claimed','expired')),
  claim_secret_hash     bytea,
  agent_id              uuid REFERENCES agents(id),
  reviewed_by_subject   text,
  reject_reason         text,
  requested_at          timestamptz NOT NULL DEFAULT now(),
  reviewed_at           timestamptz,
  claimed_at            timestamptz,
  expires_at            timestamptz NOT NULL,

  -- Approved rows must point at an agent; non-approved/non-claimed rows must not.
  CHECK (
    (status IN ('approved','claimed') AND agent_id IS NOT NULL) OR
    (status NOT IN ('approved','claimed') AND agent_id IS NULL)
  ),
  -- Approved/pending rows must still hold the secret hash; claimed/rejected/expired must not.
  CHECK (
    (status IN ('pending','approved') AND claim_secret_hash IS NOT NULL) OR
    (status IN ('claimed','rejected','expired') AND claim_secret_hash IS NULL)
  )
);

CREATE INDEX enrollment_requests_status     ON enrollment_requests(status);
CREATE INDEX enrollment_requests_expires_at ON enrollment_requests(expires_at);

-- Enforce uniqueness of pending+approved oauth_subject so two simultaneous
-- requests for the same subject can't both reach 'approved'. Closed/expired
-- requests are exempt so a rejected request can be retried.
CREATE UNIQUE INDEX enrollment_requests_subject_active
  ON enrollment_requests(oauth_subject)
  WHERE status IN ('pending','approved');
