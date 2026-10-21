# ADR 006: Immutable Auditing in Append-Only PostgreSQL with a Hash Chain

- Status: Accepted

- Context and Problem: When an airline rejects a purchase, AeroBooking must prove when and why it happened. Currently, logs are scattered, and there is no evidence of what was sent or what the airline responded with. Records must be immutable and traceable by booking.

- Alternatives Considered: (1) Append-only PostgreSQL (with `INSERT`-only permissions and a hash chain); (2) Elasticsearch/OpenSearch; (3) MongoDB; (4) Logs in Loki only.

- Decision: The Audit Service consumes `#` messages from RabbitMQ and writes them to `audit_db` using a role without `UPDATE`/`DELETE` permissions, **triggers** that block modifications, a `hash = SHA-256(prevHash + payload)` column, and an `airline_interactions` table containing the raw request and response of every call to the airline. Technical logs are sent to Loki using the same `correlationId`.

- Trade-offs:
  - Pros: Verifiable integrity (the hash chain detects tampering); SQL queries by `bookingId`/`correlationId`; no additional engine to operate; enables forensic answers to the questions: "What did AeroBooking request, what did the airline respond, and when?"
  - Cons: The database grows indefinitely and is not a full-text search engine. Mitigation: monthly partitioning, cold archiving, and Loki for free-text log searches.

- Final Justification: This solution meets legal evidence requirements with minimal complexity. Since Loki already handles full-text log searches in Wave 2, adding Elasticsearch is not justified.