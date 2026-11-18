# ADR 003: Redis for Fare Caching, Single-Flight, and Rate Limiting Toward Airlines

- Status: Accepted

- Context and Problems: Agencies repeat the same search every second, and every request reaches the airline, which penalizes requests that exceed its rate limit. Fares are valid for a limited period, so they can be served from memory during that time. Additionally, even with caching, 100 simultaneous searches during a *cache miss* could generate 100 calls to the airline (*cache stampede*).

- Considered Alternatives: (1) Redis (caching + locks + counters); (2) Memcached; (3) In-memory caching on each instance (Caffeine/node-cache); (4) HTTP CDN/proxy caching.

- Decision: Use Redis with:
- (a) Keys in the format `fare:{airline}:{origin}:{dest}:{date}:{cabin}:{pax}` and a per-airline TTL (60 seconds by default), plus a 15-second *stale-while-revalidate* window.
- (b) *Single-flight*: `SET lock:fare:{key} NX PX 5000` so that only one request queries the airline while the others wait or receive the *stale* value.
- (c) A global *token bucket* per airline (Lua script) in the Airline Connector to ensure the airline's contractual rate limit is never exceeded.
- (d) A circuit breaker that serves *stale* cached data if the airline fails.

- Trade-offs:

- Pros: Sub-millisecond reads; the number of calls to the airline depends on the TTL rather than the number of bots; explicit protection against penalties; the same Redis instance supports locks and idempotency, reducing the number of components.

- Cons: A fare may be outdated for up to the TTL, so the purchase process **revalidates the price** with the airline and fails with `PRICE_CHANGED` if it has changed. Redis is a single point of failure, mitigated through AOF persistence and, in the future, Sentinel/Cluster. If Redis goes down, the Gateway returns 503 instead of forwarding traffic to the airlines.

- Final Justification: Redis is the only option that covers caching, coordination (single-flight), and global rate limiting using a single open-source technology, directly addressing penalties caused by rate-limit violations.
