# AeroBooking — API & Contract Specification (OpenSpec)

## 1. Overview

| Service | Responsibility |
| --- | --- |
| API Gateway (Kong) | Single entry point for all client traffic: authentication enforcement, rate limiting per agency tier, and request routing to the appropriate microservice |
| Auth Service | Issues and validates JWTs / API keys for travel agencies; enforces B2B authentication (Feature 1) |
| Search Service | Queries airline fare APIs and caches results in Redis so repeated searches for the same route/date are served without hitting the external airline API (Feature 2) |
| Booking Service | Orchestrates the purchase flow end-to-end: acquires the distributed seat lock, triggers payment, and drives the compensation saga when the airline rejects a booking (Features 3 and 4) |
| Airline Connector | Sole integration point with external airline APIs; translates real airline confirmations/rejections into internal domain events |
| RabbitMQ | Asynchronous message broker connecting Booking Service, Airline Connector, and Audit Service, decoupling the purchase flow from downstream processing |
| Audit Service | Persists every domain event (lock, confirmation, rejection, compensation) tagged by correlationId, enabling forensic reconstruction of any transaction (Feature 5) |


## 2. Domain Data Schemas

### Agency
- id: UUID
- name: string
- apiKey: string (hashed, never returned in plain text)
- rateLimitTier: enum [BASIC, PREMIUM, ENTERPRISE]
- active: boolean

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

### Remaining endpoints (next iteration)

- `GET /v1/fares/search`
- `POST /v1/bookings`
- `GET /v1/bookings/{bookingId}`
- `GET /v1/audit/{correlationId}`

## 4. Asynchronous Events

### `booking.confirmed`

- **Published by:** Airline Connector
- **Consumed by:** Booking Service, Audit Service
- **Exchange / routing key:** `aerobooking.events` / `booking.confirmed`
- **Payload:**
```json
  { "bookingId": "string", "correlationId": "string", "airlineConfirmationCode": "string", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-least-once; Booking Service deduplicates by `bookingId` (inbox pattern)

### `booking.rejected`

- **Published by:** Airline Connector
- **Consumed by:** Booking Service (orchestrator), Audit Service
- **Exchange / routing key:** `aerobooking.events` / `booking.rejected`
- **Payload:**
```json
  { "bookingId": "string", "correlationId": "string", "reason": "string", "airlineErrorCode": "string", "timestamp": "ISO8601" }
```
- **Delivery guarantee:** at-least-once; consumer is idempotent (inbox pattern)

### Remaining events (next iteration)

- `booking.compensated`
- `fare.cache.miss` (optional)

## 5. Requirements & Scenarios (WHEN/THEN — one per mandatory feature)

1. **Feature 1 (B2B auth):**
   WHEN an agency sends a valid `apiKey`/`apiSecret` pair to `/v1/auth/token`
   THEN the Auth Service responds with a JWT valid for 1 hour, and any subsequent request to a protected endpoint without that JWT (or with an expired one) is rejected with `401` by the API Gateway before reaching the microservice.

2. **Feature 2 (cached search):** *(to be defined)*

3. **Feature 3 (distributed lock):**
   WHEN two agencies lock the same `flightId:seatNumber` concurrently
   THEN only the first succeeds (`200`), the second gets `409` immediately.

4. **Feature 4 (saga compensation):** *(to be defined)*

5. **Feature 5 (forensic audit):** *(to be defined)*
