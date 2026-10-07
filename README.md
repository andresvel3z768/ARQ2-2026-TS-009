# ARQ2-2026-TS-009
Proyecto de arquitectura numero 2 grupo numero 09 

Assigned Case: Case 9: AeroBooking - GDS Distribuido
Members:


Andres Mateo Velez Escobar
Jhon Alejandro Isaza Pérez
Luis Felipe Pico Gutierrez
Jhoann Jaramillo Deossa


Case 9: AeroBooking - Distributed GDS
Problematic Scenario: AeroBooking connects hundreds of travel agencies with global airline direct APIs. Agencies have bots that search for the same flight over and over every second. AeroBooking passes all these requests directly to the airlines, which charge them hefty fines for exceeding the Rate Limit and temporarily block their connection. The second major business risk happens when two different agencies try to buy seat "12A" on the same flight almost simultaneously. The AeroBooking system marks the purchase as successful for both locally, but the airline rejects the second request, triggering million-dollar manual disputes with agencies for fraud and cross-charges that the system is unable to reconcile or reverse.
5 Mandatory Features:
1. B2B authentication and key or token management for agencies.
2. Cached search engine that delivers valid fares for a set time without hitting the external airline.
3. Design of a "Distributed Lock" mechanism that temporarily separates inventory at the exact moment of checkout.
4. Orchestrated purchase flow involving the automatic compensation pattern: If the airline confirms the seat does not exist, AeroBooking must trigger the money reversal to the agency without human intervention.
5. Centralized auditing and logs system that allows forensic demonstration of when and why the airline rejected the agency's transaction.
