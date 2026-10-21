# AeroBooking — API & Contract Specification (OpenSpec)

## 1. Overview

| Service | Responsibility |
| --- | --- |
| API Gateway (Kong Gateway 3.9 OSS, DB-less mode) | Single entry point for all client traffic: validates JWT signatures locally with the Auth Service's public key, per-agency rate limiting, Idempotency-Key validation, X-Correlation-ID injection |
| Auth Service (Node.js 24 LTS + Fastify) | B2B authentication via OAuth2 `client_credentials` grant; issues short-lived JWTs (RS256) and manages rotatable API keys (Feature 1) |
| Search Service (Node.js 24 LTS + Express 5) | Cache-aside fare search against Valkey, with a single-flight lock to prevent cache-stampede on misses (Feature 2) |
| Booking Service (Node.js 24 LTS + Express 5 + amqplib) | Saga Orchestrator for the purchase flow: acquires the seat lock, holds funds, confirms with the airline, and drives automatic compensation on rejection (Features 3 and 4) |
| Airline Connector (Node.js 24 LTS + Axios + opossum) | Sole integration point with external airline APIs; translates real airline confirmations/rejections into internal domain events |
| RabbitMQ (4.3, AMQP 0-9-1) | Asynchronous broker connecting Booking Service, Airline Connector, and Audit Service, decoupling the purchase flow from downstream processing |
| Audit Service (Node.js 24 LTS + Fastify) | Persists every domain event in an append-only, hash-chained log tagged by correlationId, enabling tamper-evident forensic reconstruction of any transaction (Feature 5) |

## 2. Domain Data Schemas

### Agency
- id: UUID
- name: string
- apiKeyHash: string (bcrypt, never returned in plain text)
- rateLimitTier: enum [BASIC, PREMIUM, ENTERPRISE]
- active: boolean
- createdAt: ISO8601 datetime

### FareQuote
- quoteId: UUID
- flightId: string
- origin: string (IATA code)
- destination: string (IATA code)
- cabin: enum [ECONOMY, BUSINESS]
- price: decimal
- currency: string (ISO 4217)
- cacheKey: string — format `fare:{airline}:{origin}:{dest}:{date}:{cabin}:{pax}` (Valkey)
- cachedAt: ISO8601 datetime
- expiresAt: ISO8601 datetime (TTL 60s + 15s stale-while-revalidate window, per ADR 003)

### SeatLock
- lockId: UUID
- flightId: string
- seatNumber: string (e.g. "12A")
- agencyId: UUID
- fencingToken: integer (monotonic, via `INCR fence:{flightId}:{seat}`, per ADR 004)
- cacheKey: string — format `seatlock:{flightId}:{seat}` (Valkey, `SET NX PX 120000`)
- status: enum [ACTIVE, RELEASED, EXPIRED]
- expiresAt: ISO8601 datetime

### Booking
- bookingId: UUID
- correlationId: UUID (end-to-end tracing, used by Audit Service)
- sagaId: UUID
- agencyId: UUID
- flightId: string
- seatNumber: string
- status: enum [PENDING, CONFIRMED, REJECTED, COMPENSATING, COMPENSATED, FAILED]
- amount: decimal
- currency: string
- createdAt: ISO8601 datetime
- updatedAt: ISO8601 datetime

### PurchaseSaga
- sagaId: UUID
- bookingId: UUID
- agencyId: UUID
- state: enum [STARTED, SEAT_LOCKED, FUNDS_RESERVED, AIRLINE_CONFIRMED, COMPLETED, COMPENSATING, COMPENSATED, FAILED]
- step: integer
- fencingToken: integer
- correlationId: UUID
- attempts: integer
- updatedAt: ISO8601 datetime

### AuditEvent
- eventId: UUID
- correlationId: UUID
- sagaId: UUID (nullable)
- service: string (e.g. "airline-connector")
- eventType: string (e.g. "booking.rejected")
- payload: JSON
- hash: string (SHA-256 of prevHash + payload, per ADR 006 — immutable, append-only chain)
- timestamp: ISO8601 datetime

## 3. REST APIs

### POST /v1/auth/token

- **Auth:** none (this endpoint grants it)
- **Grant type:** OAuth2 `client_credentials` (per ADR 007)
- **Request body:**
```json
  { "grant_type": "client_credentials", "client_id": "string", "client_secret": "string", "scope": "string" }
```
- **Responses:**
  - `200 OK` → `{ "access_token": "jwt-string (RS256)", "token_type": "Bearer", "expires_in": 900 }` — 15-minute token containing `agencyId`, `scope`, `plan` claims; validated locally by the Gateway using the Auth Service's public key (no call back to Auth Service per request)
  - `401 Unauthorized` → invalid client credentials
  - `429 Too Many Requests` → agency exceeded its rateLimitTier

### POST /v1/auth/keys/rotate

- **Auth:** Bearer JWT (agency scope)
- **Responses:**
  - `200 OK` → `{ "newApiKeyId": "string", "gracePeriodEndsAt": "ISO8601" }` — old key stays valid for a 10-minute grace period (per ADR 007)
  - `401 Unauthorized` → invalid/missing token

### GET /v1/fares/search

- **Auth:** Bearer JWT (agency scope)
- **Request (query params):** `origin`, `destination`, `date`, `cabin`, `pax`
- **Responses:**
  - `200 OK` → `[ { "flightId": "string", "price": "decimal", "currency": "string", "cachedAt": "ISO8601", "expiresAt": "ISO8601" } ]`
  - `401 Unauthorized` → invalid or missing token
  - `404 Not Found` → no flights for the given criteria

### POST /v1/bookings/lock

- **Auth:** Bearer JWT (agency scope)
- **Request body:**
```json
  { "flightId": "string", "seatNumber": "string" }
```
- **Responses:**
  - `200 OK` → `{ "lockToken": "string", "fencingToken": "number", "expiresAt": "ISO8601" }`
  - `409 Conflict` → seat already locked by another agency
  - `401 Unauthorized` → invalid/missing token

### POST /v1/bookings

- **Auth:** Bearer JWT (agency scope)
- **Headers:** `Idempotency-Key: <uuid>` (required — validated by API Gateway)
- **Request body:**
```json
  { "lockToken": "string", "fareQuoteId": "string", "paymentMethodId": "string" }
```
- **Responses:**
  - `202 Accepted` → `{ "bookingId": "string", "correlationId": "string", "status": "PENDING" }`
  - `409 Conflict` → `lockToken` expired or invalid
  - `401 Unauthorized` → invalid token

### GET /v1/bookings/{bookingId}

- **Auth:** Bearer JWT (agency scope, must own the booking)
- **Responses:**
  - `200 OK` → `{ "bookingId": "string", "status": "PENDING|CONFIRMED|REJECTED|COMPENSATING|COMPENSATED|FAILED", "updatedAt": "ISO8601" }`
  - `404 Not Found` → bookingId does not exist or does not belong to the agency

### GET /v1/audit/{correlationId}

- **Auth:** Bearer JWT (admin/professor scope)
- **Responses:**
  - `200 OK` → `[ { "eventId": "string", "service": "string", "eventType": "string", "hash": "string", "timestamp": "ISO8601" } ]` (chronologically ordered; `hash` lets the chain's integrity be verified)
  - `404 Not Found` → no events for that correlationId

## 4. Asynchronous Events

All events are published to the `aerobooking.events` topic exchange over AMQP 0-9-1 (RabbitMQ 4.3), with durable per-consumer queues, publisher confirms, and manual ACKs. Every consumer implements an idempotent inbox keyed by `message_id`.

### `booking.confirmed`

- **Published by:** Airline Connector
- **Consumed by:** Booking Service, Audit Service
- **Routing key:** `booking.confirmed`
- **Payload:**
```json
  { "bookingId": "string", "correlationId": "string", "sagaId": "string", "airlineConfirmationCode": "string", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-least-once; Booking Service deduplicates by `bookingId`

### `booking.rejected`

- **Published by:** Airline Connector
- **Consumed by:** Booking Service (orchestrator), Audit Service
- **Routing key:** `booking.rejected`
- **Payload:**
```json
  { "bookingId": "string", "correlationId": "string", "sagaId": "string", "reason": "string", "airlineErrorCode": "string", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-least-once; consumer is idempotent (inbox pattern)

### `booking.compensated`

- **Published by:** Booking Service
- **Consumed by:** Audit Service
- **Routing key:** `booking.compensated`
- **Payload:**
```json
  { "bookingId": "string", "correlationId": "string", "sagaId": "string", "refundId": "string", "seatReleased": "boolean", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-least-once

### `fare.cache.miss`

- **Published by:** Search Service
- **Consumed by:** Audit Service (metrics)
- **Routing key:** `fare.cache.miss`
- **Payload:**
```json
  { "flightId": "string", "origin": "string", "destination": "string", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-most-once (informational only, not business-critical)

## 5. Requirements & Scenarios (WHEN/THEN — one per mandatory feature)

1. **Feature 1 (B2B auth):**
   WHEN an agency authenticates via the OAuth2 `client_credentials` grant with a valid `client_id`/`client_secret`
   THEN the Auth Service responds with an RS256 JWT valid for 15 minutes, the API Gateway validates its signature locally using the Auth Service's public key (no per-request call to Auth Service), and any request without a valid token is rejected with `401` before reaching the microservice.

2. **Feature 2 (cached search):**
   WHEN an agency searches fares for a route/date already queried within the last 60 seconds (TTL from ADR 003)
   THEN the Search Service responds from Valkey without calling the airline, and only re-queries the Airline Connector once the cache entry expires or falls outside the stale-while-revalidate window — emitting `fare.cache.miss` when it does.

3. **Feature 3 (distributed lock):**
   WHEN two agencies try to lock the same `flightId:seatNumber` concurrently
   THEN only the first succeeds (`200`, with a unique `fencingToken`), and the second gets `409 Conflict` immediately.

4. **Feature 4 (saga compensation):**
   WHEN the Airline Connector publishes `booking.rejected` for a Booking whose saga is in `AIRLINE_CONFIRMED` or an earlier state
   THEN the Booking Service orchestrator moves the saga to `COMPENSATING`, runs the compensating actions in reverse order (`RefundFunds` → `ReleaseSeat`), marks the Booking as `COMPENSATED`, and publishes `booking.compensated` — with no human intervention required.

5. **Feature 5 (forensic audit):**
   WHEN any service in the purchase flow emits a domain event (lock, confirmation, rejection, compensation)
   THEN the Audit Service persists an immutable, hash-chained `AuditEvent` tagged with the same `correlationId`, so that `GET /v1/audit/{correlationId}` reconstructs the full, tamper-evident timeline of that transaction.
