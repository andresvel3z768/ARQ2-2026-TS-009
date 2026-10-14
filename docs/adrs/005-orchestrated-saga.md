# ADR 005: Orchestrated Saga with Automatic Compensation for the Purchase Flow

- Status: Proposed

- Context and Problems: A purchase touches several independent resources: the seat lock (ADR 004), the agency's balance, and the airline's booking API, which is slow, unstable, and the only source of truth for seat availability. Today AeroBooking marks the purchase as successful locally before the airline answers. When the airline rejects the seat, the agency has already been charged, nothing undoes it automatically, and the result is million-dollar manual disputes. A distributed ACID transaction (2PC) is not possible because the airline is an external system that does not take part in our transactions. The business requires that **if the airline confirms that the seat does not exist, the money is returned to the agency without human intervention**. Every step and every compensation must also be traceable for forensic auditing.

- Considered Alternatives: (1) Orchestrated saga (a central coordinator in the Booking Service); (2) Choreographed saga (each service reacts to the others' events with no coordinator); (3) Two-Phase Commit (2PC/XA); (4) Synchronous HTTP chain with try/catch rollback; (5) Workflow engine (Temporal/Camunda).

- Decision: Implement an **orchestrated saga** inside the Booking Service (Saga Orchestrator). It sends commands and receives replies over RabbitMQ (ADR 002) and keeps the saga's state in `booking_db` (PostgreSQL).

  - **State machine** (table `purchase_saga`: `saga_id`, `booking_id`, `agency_id`, `state`, `step`, `fencing_token`, `correlation_id`, `attempts`, `updated_at`):
    `STARTED → SEAT_LOCKED → FUNDS_RESERVED → AIRLINE_CONFIRMED → COMPLETED`, or on failure `COMPENSATING → COMPENSATED` (final state `FAILED` with a reason code).

  - **Steps and their compensations**:

    | # | Step (command) | Executed by | Compensation |
    |---|----------------|-------------|--------------|
    | 1 | `LockSeat` (returns the *fencing token*) | Inventory (Redis, ADR 004) | `ReleaseSeat` (Lua release that checks the token) |
    | 2 | `RevalidatePrice` | Airline Connector | — (read-only; fails with `PRICE_CHANGED`) |
    | 3 | `ReserveFunds` (debits the agency balance and records it as a hold) | Booking Service / balance ledger | `RefundFunds` (credit entry in the ledger) |
    | 4 | `ConfirmWithAirline` (the *pivot* step) | Airline Connector | `CancelAirlineBooking` (only if the airline confirmed but a later step failed) |
    | 5 | `MarkSeatSold` + `CompleteBooking` | Inventory / Booking Service | — (retriable steps, always completed after the pivot) |

  - **Automatic compensation**: if the airline replies `SEAT_NOT_AVAILABLE` (or any business rejection), the orchestrator moves to `COMPENSATING` and runs the compensations in **reverse order**: `RefundFunds` → `ReleaseSeat`. The booking ends as `FAILED` with the airline's reason code, and the agency is notified. No human takes part.

  - **Timeouts and retries**: every command has a timeout (the airline confirmation gets 30 s) and up to 3 retries with exponential backoff, sent through RabbitMQ's TTL queues. If an airline call times out, the result is unknown, so the orchestrator **queries the booking status** at the airline (using the same idempotency key) before deciding whether to compensate. That way it never refunds a seat the airline actually sold. Messages that fail all their retries go to the DLX and raise an alert.

  - **Reliability**: state changes and outgoing commands are written in the same local transaction through a **transactional outbox** (`outbox` table plus a relay to RabbitMQ). Every participant handles messages through an **idempotent inbox** keyed by `message_id`. Compensations are idempotent as well: refunding twice or releasing an already-released seat has no effect. Each command carries the `saga_id` and `X-Correlation-ID` (ADR 001) and the *fencing token* (ADR 004). A participant discards commands that carry an older token.

  - **Recovery**: after a restart, the orchestrator resumes any saga that is not in a final state from its persisted `state`/`step`. A periodic job looks for sagas stuck longer than their timeout and either moves them forward or compensates them.

  - **Auditing**: every transition, command, reply, and compensation is published as an event (`saga.*`) that the Audit Service stores in its append-only log. Each event includes the airline's raw response and reason code, so it is possible to show forensically when the airline rejected a purchase, why, and when the refund was made.

- Trade-offs:

  - Pros: The whole purchase flow lives in one place and can be read as an explicit state machine, which makes it easy to test, debug, and audit. Compensation happens automatically and deterministically, which removes the manual disputes. No locks or open transactions are held while waiting for the slow airline. The orchestrator handles timeouts and the "unknown outcome" case explicitly. Adding or reordering steps does not require changing the other services.

  - Cons: The system is **eventually consistent**: for a few seconds the agency may see a `PENDING` booking with funds on hold. **Mitigation**: the API returns `202 Accepted` with the `booking_id`, and the agency checks the status or receives a webhook. The orchestrator is a central component that could become a bottleneck or a point of failure. **Mitigation**: it is stateless apart from PostgreSQL, so several instances can run, each saga is handled by a single instance at a time (row lock / `SELECT ... FOR UPDATE SKIP LOCKED` on the saga row), and work continues from the persisted state. The outbox, inbox, and idempotent compensations add code and tables. A compensation cannot "un-send" a notification that was already delivered, so the agency is notified only once the saga reaches a final state.

- Final Justification: The fourth mandatory feature requires an orchestrated purchase flow that refunds the agency automatically when the airline rejects the seat. The orchestrated saga does exactly that. Choreography was rejected because, with five steps plus compensations, the flow would be spread across many services and would be hard to follow and audit, which is the very problem we need to solve. 2PC is not possible with an external airline, and it would hold locks for the whole duration of a slow call. A synchronous HTTP chain loses the transaction state if a process crashes in the middle. Temporal or Camunda would add an extra platform to operate that a project of this size does not need, although they remain an option if the flow grows. Together with the seat lock (ADR 004), RabbitMQ (ADR 002), and the Audit Service, this decision closes the gap between local success and the airline's actual answer.
