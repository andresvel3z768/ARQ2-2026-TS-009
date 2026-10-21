# ADR 007: B2B Authentication with OAuth2 Client Credentials, Short-Lived JWTs, and Rotatable API Keys

- Status: Accepted

- Context and Problem: Clients are agency systems (bots and portals), not individuals. Strong identification, rate limiting, agency-specific permissions, credential rotation, and revocation without affecting other agencies are required.

- Alternatives Considered: (1) OAuth2 client credentials with JWTs and rotatable API keys; (2) Static API keys only; (3) mTLS per agency; (4) Full Keycloak implementation.

- Decision: The Auth Service issues 15-minute JWTs signed with RS256, containing the `agencyId`, `scope`, and `plan` claims, using the `client_credentials` grant. The Gateway validates the signature locally using the public key, without calling the Auth Service on every request. API keys are stored as hashes, can be rotated with a 10-minute grace period, and can be revoked immediately using a revocation list in Redis.

- Trade-offs:
  - Pros: Microsecond-level validation at the Gateway; short-lived tokens limit the damage caused by credential leaks; a well-known standard for agencies; the token's `agencyId` supports rate limiting, the ledger, and auditing.
  - Cons: Revoking an already-issued JWT is not immediate. Mitigation: a revocation list in Redis checked by the Gateway and a 15-minute token lifetime. Neither mTLS nor Keycloak is adopted due to the operational overhead relative to the scope of the course.

- Final Justification: This approach balances security and simplicity in a B2B environment and avoids coupling every request to the authentication service.