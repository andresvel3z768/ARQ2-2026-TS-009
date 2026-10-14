# ADR 002: RabbitMQ as the Messaging Broker for the Purchase Saga

- Status: Proposed

- Context and Problems: The purchase workflow involves inventory, agency balance, and a slow and unstable external airline. It must tolerate partial failures, retries, and the delivery of commands and responses between services without synchronous coupling. Service-specific queues, routing by event type, dead-letter handling, and delivery acknowledgments are required.

- Considered Alternatives: (1) RabbitMQ; (2) Apache Kafka; (3) Redis Streams; (4) Synchronous HTTP between services.

- Decision: Use RabbitMQ with a `topic` exchange (`aerobooking.events`), durable consumer-specific queues, *publisher confirms*, manual *consumer acknowledgments (acks)*, and a DLX for failed messages.

- Trade-offs:

- Pros: Flexible routing through routing keys (commands and events on the same bus); native DLQ and TTL support for retries; low message latency; simple operation in a single container with a management console.

- Cons: Lower raw throughput than Kafka and no historical *replay*. **Mitigation**: Historical records are handled by the Audit Service (append-only), and purchase volume is moderate. Delivery is *at-least-once*, so all consumers implement an idempotent inbox.

- Final Justification: The use case requires command-and-response orchestration with controlled retries rather than a massive event log. RabbitMQ provides this with less operational complexity than Kafka and significantly greater robustness than chained HTTP calls.
