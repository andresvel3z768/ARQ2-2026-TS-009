CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS agencies (
  id UUID PRIMARY KEY, name TEXT NOT NULL, rate_limit_tier TEXT NOT NULL DEFAULT 'BASIC',
  balance NUMERIC(14,2) NOT NULL DEFAULT 100000, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), agency_id UUID NOT NULL REFERENCES agencies(id),
  client_id TEXT NOT NULL UNIQUE, client_secret_hash TEXT NOT NULL, allowed_scopes TEXT[] NOT NULL DEFAULT ARRAY['fares:read','bookings:write','bookings:read','keys:rotate'], active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS allowed_scopes TEXT[] NOT NULL DEFAULT ARRAY['fares:read','bookings:write','bookings:read','keys:rotate'];
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), agency_id UUID NOT NULL REFERENCES agencies(id),
  key_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, grace_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fare_quotes (
  quote_id UUID PRIMARY KEY, flight_id TEXT NOT NULL, airline TEXT NOT NULL, origin CHAR(3) NOT NULL,
  destination CHAR(3) NOT NULL, travel_date DATE NOT NULL, cabin TEXT NOT NULL, pax INTEGER NOT NULL,
  price NUMERIC(12,2) NOT NULL, currency CHAR(3) NOT NULL, cached_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS seat_locks (
  lock_id UUID PRIMARY KEY, flight_id TEXT NOT NULL, seat_number TEXT NOT NULL, agency_id UUID NOT NULL,
  lock_token TEXT NOT NULL UNIQUE, fencing_token BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE',
  expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_seat_lock ON seat_locks(flight_id, seat_number) WHERE status = 'ACTIVE';
CREATE TABLE IF NOT EXISTS bookings (
  booking_id UUID PRIMARY KEY, correlation_id UUID NOT NULL, saga_id UUID NOT NULL UNIQUE,
  agency_id UUID NOT NULL, flight_id TEXT NOT NULL, seat_number TEXT NOT NULL, fare_quote_id UUID NOT NULL,
  status TEXT NOT NULL, amount NUMERIC(12,2) NOT NULL, currency CHAR(3) NOT NULL,
  airline_reason TEXT, airline_confirmation_code TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_saga (
  saga_id UUID PRIMARY KEY, booking_id UUID NOT NULL REFERENCES bookings(booking_id), agency_id UUID NOT NULL,
  state TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, fencing_token BIGINT NOT NULL,
  correlation_id UUID NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lock_token TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agency_saga_idempotency_idx ON purchase_saga(agency_id,idempotency_key);
CREATE TABLE IF NOT EXISTS agency_ledger (
  entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), agency_id UUID NOT NULL, booking_id UUID NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('HOLD','CAPTURE','REFUND','RELEASE')),
  amount NUMERIC(12,2) NOT NULL, idempotency_ref TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY, message_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, routing_key TEXT NOT NULL, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox(id) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS inbox (
  message_id TEXT PRIMARY KEY, processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY, event_id UUID NOT NULL UNIQUE, correlation_id UUID NOT NULL,
  saga_id UUID, booking_id UUID, service TEXT NOT NULL, event_type TEXT NOT NULL,
  payload JSONB NOT NULL, prev_hash TEXT, hash TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
  stored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_correlation_idx ON audit_log(correlation_id, id);
CREATE INDEX IF NOT EXISTS audit_booking_idx ON audit_log(booking_id, id);
CREATE TABLE IF NOT EXISTS airline_interactions (
  interaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), booking_id UUID,
  correlation_id UUID NOT NULL, request_payload JSONB NOT NULL, response_payload JSONB,
  http_status INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS block_audit_mutation ON audit_log;
CREATE TRIGGER block_audit_mutation BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE OR REPLACE FUNCTION compute_audit_hash() RETURNS trigger AS $$
DECLARE previous_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(912009);
  SELECT hash INTO previous_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := previous_hash;
  NEW.hash := encode(digest(convert_to(COALESCE(previous_hash, '') || NEW.payload::text, 'UTF8'), 'sha256'), 'hex');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS compute_hash_chain ON audit_log;
CREATE TRIGGER compute_hash_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION compute_audit_hash();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM agencies WHERE id='00000000-0000-4000-8000-000000000009') THEN
    INSERT INTO agencies(id,name,rate_limit_tier,balance) VALUES ('00000000-0000-4000-8000-000000000009','Demo Travel Agency','PREMIUM',100000.00);
  END IF;
END $$;

DO $$ BEGIN
  CREATE ROLE aerobooking_audit LOGIN PASSWORD 'audit_writer_dev';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT SELECT, INSERT ON audit_log TO aerobooking_audit;
GRANT SELECT, INSERT ON inbox TO aerobooking_audit;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO aerobooking_audit;
