# Duchess Rewards MVP Foundation

## Product summary

Duchess Rewards is the working name for a premium loyalty programme for Duchess & Butler clients.

The MVP foundation added in Phase 1A is intentionally narrow:

- store loyalty clients
- store suggested and approved loyalty transactions
- store configurable reward settings
- calculate rewards locally in a pure helper without changing live app behavior

## Architecture decision

- Duchess Rewards lives inside the Duchess App ecosystem.
- The future admin area will live inside the internal Duchess App.
- The future client-facing portal is expected to use a separate route and layout, for example `/rewards/:token`.
- The client portal should feel like a separate luxury website while still being able to share the same repo and Supabase project.

## Reward rules

- Point value: `1 point = 0.5 pence`
- Base reward: `3%` of eligible order value
- Hybrid model: base order value points plus strategic category bonuses
- Strategic bonus categories:
  - linen
  - chairs
  - furniture
- MVP bonus defaults:
  - linen: `20%` of base points
  - chairs: `15%` of base points
  - furniture: `15%` of base points

## Lifecycle states

Transactions support the following states:

- `suggested`
- `pending`
- `available`
- `redeemed`
- `rejected`
- `cancelled`

Points become eligible to become available after the event date delay. For MVP, the default delay is `3 days`.

Manual approval is mandatory before points can become `available`. This phase does not make any points available automatically.

## Manual client enrolment (Phase 2A)

Admins (`public.users.role = 'admin'`, matching RLS on `loyalty_clients`) can create loyalty client rows from **Duchess Rewards → Add client**. The database stores **`tier = 'standard'`** (entry tier); the admin UI labels this as **Pearl**. **No** loyalty transactions are created; **no** points are calculated from orders or the rewards engine in this step; a **cryptographic `portal_token`** is generated for future portal use only and **must not** be exposed as a public link in MVP admin.

## Needs Attention

The rewards engine includes a conservative `Needs Attention` concept for unclear cases. In MVP foundation terms, this means:

- missing or invalid eligible order value
- missing item data
- unclear category data for bonus classification

The engine is deliberately cautious and prefers review over aggressive automatic categorisation.

## Files added in this phase

- SQL foundation: `src/database/duchess_rewards_foundation.sql`
- RLS / security preparation (manual apply after foundation): `src/database/duchess_rewards_rls.sql`
- Pure helper: `src/lib/duchessRewardsEngine.js`
- Documentation: `docs/duchess-rewards-mvp.md`

## SQL scope

The SQL foundation file creates:

- `loyalty_clients`
- `loyalty_transactions`
- `loyalty_settings`

It also adds:

- indexes for the initial lookup paths
- `updated_at` triggers for the new rewards tables
- one safe default active settings row if no active settings row exists yet

RLS is intentionally left for a later security-specific step, once the internal admin workflow and the token-based client portal access model are finalised.

## Security / RLS before applying SQL

For any environment that will hold real loyalty data (client names, emails, portal tokens, transactions and balances):

- **Do not apply `duchess_rewards_foundation.sql` alone** for live internal use once the Duchess App is pointing at Supabase — the foundation deliberately omits Row Level Security. Treat **foundation + reviewed RLS** as the minimal safe bundle for shared projects.
- **Loyalty data is sensitive** (PII plus reward economics). Access should be locked down before non-admin staff or future public surfaces connect to the same database.
- **MVP access model** is **admin-only** for loyalty tables. The reviewable policy file is `src/database/duchess_rewards_rls.sql`: it enables RLS on `loyalty_clients`, `loyalty_transactions`, and `loyalty_settings`, and grants **only** `public.users` rows with `role = 'admin'` the ability to select/insert/update (no delete policies in that file; no anonymous access).
- **Operations and driver** users are **not** granted loyalty table access in that file unless you extend it deliberately.
- **Client portal** access by magic link (`/rewards/:token`) is **not** implemented in the RLS file — anonymous or token-based reads must be designed later (e.g. narrow RPC or dedicated policy), not enabled by default.
- **Application of SQL** remains **manual** (Supabase SQL Editor or your controlled migration process). The app does not run these scripts.

## Engine helper scope

`src/lib/duchessRewardsEngine.js` is a pure JavaScript helper with no React and no Supabase calls.

It currently covers:

- base points calculation
- strategic bonus calculation
- reward value conversion
- suggested reward assembly
- available-at date calculation
- conservative local strategic category classification

Rounding rules are intentionally conservative:

- base points use `Math.floor`
- bonus points use `Math.floor`
- reward value in pence uses `Math.round` because the schema stores integer pence snapshots

## Intentionally not built yet

This phase does not include:

- RMS sync integration
- automatic reward transaction creation
- automatic point approvals
- automatic redemptions
- payment or invoice integration
- client portal UI
- admin UI
- changes to orders, schedule, fleet, labels, inventory, paperwork, driver portal, DB Linen Studio, auth, or unrelated pages

The goal of Phase 1A is only to add a controlled, reviewable foundation without changing production behavior.
