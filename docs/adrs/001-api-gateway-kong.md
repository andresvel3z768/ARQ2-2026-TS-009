# ADR 001: API Gateway as an only entry point (Kong)

- Status: Accepted

- Context and Problems: Hundreds of agencies have bots that query the same flight every second, and these requests currently go directly to the airlines, which impose penalties for exceeding their rate limits. Additionally, each service reimplements authentication, and there is no idempotency validation at the point of purchase entry. A single entry point is needed to authenticate requests, rate-limit traffic per agency, validate the Idempotency-Key, and generate the X-Correlation-ID.

- Considered Alternatives: (1) Kong Gateway (OSS) with plugins; (2) Apache APISIX; (3) Gateway propio en Node.js/Express; (4) Nginx con Lua.

- Decision:Kong Gateway (DB-less mode, using declarative configuration in kong.yml) with the jwt/key-auth, rate-limiting (with a redis policy), and correlation-id plugins, along with a lightweight idempotency plugin backed by Redis.

- Trade-offs:

- Pros: Per-agency rate limiting without writing custom code; centralized authentication; version-controlled configuration in the repository; simple deployment using Docker Compose; abusive requests are rejected (429) before reaching any microservice.

- Cons: It is a single point of failure and adds approximately 1–3 ms of latency. **Mitigation**: Use stateless DB-less replicas and health checks; the state is stored in Redis. The idempotency plugin requires a small Lua component.

- Final Justification: It directly addresses bot abuse (the first problem in the case) and keeps entry-point rules outside the business logic. Kong is open source, extensively documented, and meets the requirement of an “API Gateway as the single entry point.”