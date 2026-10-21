# ADR 004: Distributed Seat Locking with Redis and Fencing Tokens

- Status: Accepted

- Context and Problems: Two agencies may attempt to purchase seat 12A on the same flight at almost the same time. Currently, both receive a local success response, and only afterward does the airline reject the second request. Inventory must be reserved exclusively for a short period immediately before checkout, preventing a slow or paused process (due to garbage collection or network delays) from continuing to act with an expired lock.

- Considered Alternatives: (1) Redis lock (`SET key token NX PX ttl`) with a fencing token; (2) Redlock across multiple Redis nodes; (3) `SELECT ... FOR UPDATE` in PostgreSQL; (4) ZooKeeper/etcd.

- Decision: The Inventory Service acquires `seatlock:{flightId}:{seat}` using `SET NX PX 120000` (with a unique token as the value) and increments a counter using `INCR fence:{flightId}:{seat}` to generate a *fencing token* that is passed along with subsequent commands. The lock is released through a Lua script that verifies the token. The final state (`SOLD`) is persisted in `inventory_db`.

- Trade-offs:

- Pros: Acquisition in microseconds without blocking SQL connections; TTL prevents permanent locks if a service crashes; the fencing token allows messages from an expired lock holder to be discarded; no open transactions are maintained while waiting for the airline.

- Cons: A lock on a single Redis instance does not provide an absolute guarantee during network partitions or failover. Mitigation: The lock reduces contention but is not the source of truth. The airline is the authoritative source, so the saga treats its rejection as a normal case and triggers automatic compensation (ADR 005). Redlock is rejected due to its complexity and the debate surrounding its correctness.

- Final Justification: Redis locking combined with saga compensation provides practical consistency with minimal latency. Locking rows in PostgreSQL would recreate the problem of long-held locks while waiting for a slow external service.