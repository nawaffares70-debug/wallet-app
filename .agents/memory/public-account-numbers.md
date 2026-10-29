---
name: Public account numbers
description: The compatibility rule for public currency account numbers and internal account IDs.
---

Public account numbers are nine digits beginning with 7. Each internal account receives three consecutive public numbers in the fixed order USD, YER, SAR; the first account therefore maps to 700000001, 700000002, and 700000003.

**Why:** Existing database relations, transaction records, JWT claims, and realtime notification lookups depend on the internal account ID. Replacing that key would break data relationships, so public numbers must be translated at the API boundary.

**How to apply:** Display and accept public numbers in user-facing screens and API inputs, then resolve them to internal IDs before database queries. Keep internal IDs available only for server-side ownership, joins, transactions, and Socket.IO routing.