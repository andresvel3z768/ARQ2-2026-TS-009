# AeroBooking — Wave 2 Implementation

**Team:** 009  
**Assigned case:** Case 9 — AeroBooking: Distributed GDS  
**Repository:** https://github.com/andresvel3z768/ARQ2-2026-TS-009.git  
**Tech Spec (Google Docs):** https://docs.google.com/document/d/15p6cG6IwW_TF4gdOVqE9SkyBVj_hQbXlB5tfVk33TTE/edit?tab=t.0#heading=h.l439icxm5mjb

This monorepo implements the Wave 1 contracts in `docs/spec.md` and preserves the accepted ADRs and C4 Level 2 diagram. All deliverables and code comments are in English.

## Architecture

- **Kong Gateway 3.9 OSS (DB-less):** single public entry point, JWT verification, per-agency consumer rate limiting, correlation ID, and Redis-backed `Idempotency-Key` guard.
- **Auth Service (Fastify):** OAuth2 Client Credentials, RS256 access tokens (15-minute lifetime), hashed client secrets, and API-key rotation endpoint.
- **Search Service (Express):** cache-aside fare search, 60-second TTL, 15-second stale window, and Redis single-flight.
- **Booking Service (Express):** Redis seat lock (`SET NX PX`), monotonic fencing token, persisted purchase saga, transactional outbox, idempotent inbox, ledger hold/refund, and reconciliation sweep.
- **Airline Connector:** sole airline integration boundary, token bucket in Valkey, circuit breaker, mock airline adapter, and raw interaction capture.
- **Audit Service (Fastify):** RabbitMQ consumer, append-only PostgreSQL hash chain, airline interaction evidence, and correlation-based forensic query.
- **Infrastructure:** PostgreSQL 18, Valkey 8, RabbitMQ 4.3, Prometheus, Loki, Promtail, and Grafana.

The airline endpoint is a deterministic mock adapter for local Wave 2 demonstrations. Replace the adapter in `services/airline-connector/index.js` with the provider-specific HTTP client when real airline credentials/contracts are available.

## Prerequisites

- Docker Engine and Docker Compose v2.
- Ports available: `3000`, `3001`–`3005` (internal services), `3100`, `5432`, `5672`, `6379`, `8000`, `8001`, `9090`, `15672`.

## Run the full stack

```bash
cp .env.example .env
npm run setup                 # Generates local-only RS256 keys and Kong DB-less config
# Start all infrastructure and services
docker compose up --build -d

docker compose ps
```

The first PostgreSQL startup applies `infrastructure/postgres/init.sql`. To reset the local demo database and volumes:

```bash
docker compose down -v
docker compose up --build -d
```

Do not use the default credentials or generated development keys outside a local classroom environment.

## Demo credentials

```text
client_id:     demo-client
client_secret: demo-secret-change-me
admin client_id: demo-admin
admin client_secret: demo-admin-secret-change-me
```

Change them in `.env` before deployment. The bootstrap SQL seeds the demo agency with a starting ledger balance of USD 100,000.

## End-to-end demo

### 1. Obtain an agency token

```bash
TOKEN=$(curl -s http://localhost:8000/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"demo-client","client_secret":"demo-secret-change-me","scope":"fares:read bookings:write bookings:read keys:rotate"}' | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).access_token')
```

### 2. Search fares (first call misses, next calls hit Valkey)

```bash
curl -s 'http://localhost:8000/v1/fares/search?origin=BOG&destination=MDE&date=2026-12-10&cabin=ECONOMY&pax=1' \
  -H "Authorization: Bearer $TOKEN"
```

Copy a returned `quoteId` and `flightId`.

### 3. Lock a seat

```bash
curl -s http://localhost:8000/v1/bookings/lock \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"flightId":"DEMO-BOGMDE-20261210-01","seatNumber":"14A"}'
```

Copy `lockToken`. A second agency/token attempting the same flight and seat receives `409 SEAT_ALREADY_LOCKED`.

### 4. Start the asynchronous booking saga

```bash
curl -i http://localhost:8000/v1/bookings \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 8dbecc2a-29d7-4e6a-bd4d-3d04b02f4001' \
  -d '{"flightId":"DEMO-BOGMDE-20261210-01","seatNumber":"14A","lockToken":"PASTE_LOCK_TOKEN","fareQuoteId":"PASTE_QUOTE_ID","paymentMethodId":"demo-payment"}'
```

The API validates that `flightId` and `seatNumber` match the active lock, then returns `202 Accepted`. The Booking Service publishes `cmd.airline.book` with routing key `command.airline.book`; the Airline Connector consumes that command. Poll `GET /v1/bookings/{bookingId}`. The mock airline rejects seat `12A` by default (`AIRLINE_REJECT_SEATS=12A`) to demonstrate automatic compensation; use `14A` to demonstrate confirmation.

### 5. Inspect forensic evidence

```bash
ADMIN_TOKEN=$(curl -s http://localhost:8000/v1/auth/token -H 'Content-Type: application/json' -d '{"grant_type":"client_credentials","client_id":"demo-admin","client_secret":"demo-admin-secret-change-me","scope":"admin"}' | node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).access_token')
curl -s "http://localhost:8000/v1/audit/PASTE_CORRELATION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
curl -s "http://localhost:8000/v1/audit/PASTE_CORRELATION_ID/verify" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Agency onboarding (per-agency Gateway rate limits)

Each agency is provisioned as one Kong consumer. Multiple OAuth client IDs for the same agency share that consumer, so Kong's Redis rate-limit counter is scoped per agency rather than globally.

Set these variables in `.env` and run the provisioning command after the stack is healthy:

```bash
NEW_AGENCY_ID=00000000-0000-4000-8000-000000000010 \
NEW_AGENCY_NAME='Example Travel Agency' \
NEW_CLIENT_ID=example-agency-client \
NEW_CLIENT_SECRET='replace-with-a-strong-secret' \
docker compose run --rm keygen node scripts/provision-agency.js
```

The provisioning endpoint is internal-only and requires `PROVISIONING_SECRET`. It stores the credential hash and allowed scopes, adds the agency's RS256 JWT credential to the DB-less Kong config, and reloads Kong through its Admin API. If Kong is temporarily unavailable, the config file is updated and the endpoint returns `202`; retry gateway synchronization with the internal `/internal/agencies/{agencyId}/sync-gateway` endpoint.

### Credential rotation and revocation

- `POST /v1/auth/keys/rotate` returns a new API key once; the previous key remains valid for 10 minutes.
- `POST /v1/auth/keys/revoke` with `{ "apiKeyId": "..." }` revokes a key immediately.
- `POST /v1/auth/tokens/revoke` revokes the current JWT by `jti`; Kong and the services fail closed when the Valkey revocation list is unavailable.

## Observability

| Component | URL | Local credentials |
|---|---|---|
| Kong Proxy | http://localhost:8000 | Bearer JWT |
| Kong Admin API | http://localhost:8001 | Local development only |
| RabbitMQ Management | http://localhost:15672 | `aerobooking / aerobooking_dev` |
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3000 | `admin / admin` |
| Loki | http://localhost:3100 | — |

Prometheus scrapes Search and Booking metrics. Promtail ships container logs to Loki. Search logs by `correlationId` in Grafana Explore.

## Contract and ADR alignment

- `docs/spec.md` in this repository is the updated source of truth for API and event contracts.
- `docs/adrs/001`–`007` are the latest accepted versions supplied in the updated project archive.
- `docs/assets/aerobooking-c4-level2.drawio.png` remains the Wave 1 C4 diagram.
- Valkey is used as the Redis-protocol-compatible implementation shown in the C4 diagram and `spec.md`.

## Wave 2 implementation notes

1. Bootstrap creates a Kong consumer per agency and places its OAuth client IDs in that consumer's JWT credentials. The internal Auth Service provisioning route adds new client IDs to the DB-less Kong config and reloads it through the Admin API; all clients for one agency share the same consumer and rate-limit bucket. The classroom deployment uses one Auth Service RS256 signing key for all agencies, so production must additionally secure the Admin API and implement a signing-key rotation policy.
2. The custom Kong `idempotency` plugin records the first key for 24 hours and validates its presence at the edge. Repeated requests are passed to the Booking Service, which persists the key in PostgreSQL and returns the original booking instead of creating a duplicate.
3. The saga never compensates an `AIRLINE_UNKNOWN` timeout until the Airline Connector's status reconciliation returns a conclusive outcome. Unknown outcomes remain pending and are audited rather than risking an incorrect refund.
4. The demo payment integration is an internal agency ledger. The `paymentMethodId` is accepted as the contract's payment reference; no external payment processor credentials were supplied.
5. Audit evidence is append-only in PostgreSQL. The DB trigger computes the SHA-256 chain and rejects UPDATE/DELETE. The dedicated audit database role has SELECT/INSERT only (needed to read the previous hash and append records); production should configure monthly partitioning and cold archival.
6. The compose stack is a local development topology, not a highly available production deployment. Redis/Valkey Sentinel or Cluster, replicated Kong, TLS, secrets management, backups, and multi-node PostgreSQL are production hardening tasks.

## Team contribution requirement

The course rubric requires verifiable Wave 2 commits from **every** team member. After reviewing the implementation, each member should commit a meaningful part of the code/infrastructure using their own GitHub account. Do not create commits under another member's identity.
