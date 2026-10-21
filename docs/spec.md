# AeroBooking — API & Contract Specification (OpenSpec)

## 1. Overview

| Service | Responsibility |
| --- | --- |
| API Gateway (Kong Gateway 3.9 OSS, DB-less mode) | Single entry point for all client traffic: JWT/API-key enforcement, per-agency rate limiting, Idempotency-Key validation, X-Correlation-ID injection |
| Auth Service (Node.js 24 LTS + Fastify + jsonwebtoken) | Issues and validates JWTs (HS256); stores agency API keys hashed with bcrypt in PostgreSQL |
| Search Service (Node.js 24 LTS + Express 5) | Cache-aside fare search against Valkey, with a single-flight lock to prevent cache-stampede on misses |
| Booking Service (Node.js 24 LTS + Express 5 + amqplib) | Saga Orchestrator for the purchase flow: acquires the seat lock, holds funds, confirms with the airline, and drives automatic compensation on rejection |
| Airline Connector (Node.js 24 LTS + Axios + opossum circuit breaker) | Sole integration point with external airline APIs; applies a per-airline token-bucket rate limiter and a circuit breaker |
| RabbitMQ (4.3, AMQP 0-9-1) | Asynchronous broker; topic exchange `aerobooking.events`, durable per-consumer queues, publisher confirms, manual ACKs, DLX for poison messages |
| Audit Service (Node.js 24 LTS + Fastify) | Consumes `saga.*`, `booking.*` and `airline.*` events; append-only forensic log in PostgreSQL, queryable by `correlationId` |
| Valkey (9.x OSS, RESP3) | Fare cache (TTL + stale-while-revalidate), seat locks (`SET NX PX` + fencing token via Lua), per-airline rate-limit counters, idempotency keys |
| PostgreSQL (18) | `booking_db`: agencies, bookings, `purchase_saga` state, transactional outbox/inbox, agency balances, `audit_log` |

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
- sagaId: UUID (nullable — not every audited event belongs to a saga)
- service: string (e.g. "airline-connector")
- eventType: string (e.g. "booking.rejected")
- payload: JSON
- timestamp: ISO8601 datetime

## 3. REST APIs

### POST /v1/auth/token

- **Auth:** none (this endpoint grants it)
- **Request body:**
```json
  { "apiKey": "string", "apiSecret": "string" }
```
- **Responses:**
  - `200 OK` → `{ "accessToken": "jwt-string", "expiresIn": 3600 }`
  - `401 Unauthorized` → invalid credentials
  - `429 Too Many Requests` → agency exceeded its rateLimitTier

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
  - `202 Accepted` → `{ "bookingId": "string", "correlationId": "string", "status": "PENDING" }` (the saga starts asynchronously)
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
  - `200 OK` → `[ { "eventId": "string", "service": "string", "eventType": "string", "timestamp": "ISO8601" } ]` (chronologically ordered)
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
   WHEN an agency sends a valid `apiKey`/`apiSecret` pair to `/v1/auth/token`
   THEN the Auth Service responds with a JWT valid for 1 hour, and any subsequent request to a protected endpoint without that JWT (or with an expired one) is rejected with `401` by the API Gateway before reaching the microservice.

2. **Feature 2 (cached search):**
   WHEN an agency searches fares for a route/date already queried within the last 60 seconds (TTL from ADR 003)
   THEN the Search Service responds from Valkey without calling the airline, and only re-queries the Airline Connector once the cache entry expires or falls outside the stale-while-revalidate window — emitting `fare.cache.miss` when it does.

3. **Feature 3 (distributed lock):**
   WHEN two agencies try to lock the same `flightId:seatNumber` concurrently
   THEN only the first succeeds (`200`, with a unique `fencingToken`), and the second gets `409 Conflict` immediately — no partial or duplicate lock is ever granted.

4. **Feature 4 (saga compensation):**
   WHEN the Airline Connector publishes `booking.rejected` for a Booking whose saga is in `AIRLINE_CONFIRMED` or an earlier state
   THEN the Booking Service orchestrator moves the saga to `COMPENSATING`, runs the compensating actions in reverse order (`RefundFunds` → `ReleaseSeat`), marks the Booking as `COMPENSATED`, and publishes `booking.compensated` — with no human intervention required.

5. **Feature 5 (forensic audit):**
   WHEN any service in the purchase flow emits a domain event (lock, confirmation, rejection, compensation)
   THEN the Audit Service persists an `AuditEvent` tagged with the same `correlationId`, so that `GET /v1/audit/{correlationId}` reconstructs the full timeline of that transaction, including the airline's raw rejection reason when applicable.