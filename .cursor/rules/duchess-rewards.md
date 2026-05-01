# CURSOR.md — Duchess & Butler / Duchess Rewards

## Purpose

This file defines how Cursor should work inside the Duchess & Butler ecosystem, especially when building **Duchess Rewards**.

It combines:

1. **Engineering safety** for the existing Duchess App, DB Linen Studio and operational systems.
2. **Premium brand discipline** for the Duchess Rewards client-facing experience.

Duchess Rewards must feel like a private client privilege programme, not a generic points or discount app.

---

# 1. Project Identity

## Duchess & Butler Ecosystem

The codebase supports real operational systems for Duchess & Butler:

- Duchess App
- Current RMS synced operational data
- Schedule / Orders / Paperwork / Fleet / Labels
- DB Linen Studio
- Duchess Rewards

This is not a playground. It supports real jobs, clients, events and business workflows.

## Current RMS Is Source of Truth

Current RMS remains canonical for:

- confirmed orders
- client/order references
- job/order data
- RMS item names
- event/delivery/collection dates
- operational order records

Duchess App is an operational layer on top of RMS. Do not treat it as a replacement for RMS.

## DB Linen Studio Boundary

DB Linen Studio owns linen operations:

- linen condition reporting
- damaged/missing/stained linen workflows
- laundry workflows
- TDS portal/report access
- linen-specific admin operations

Duchess Rewards may **read** whether an order includes linen for bonus purposes, but it must not take ownership of linen operations.

---

# 2. Non-Negotiable Engineering Rules

## Always Be Surgical

Prefer small, controlled, reviewable changes.

Do not perform broad refactors unless explicitly requested.

Before editing, classify the task:

```text
data
matching
UI
output/PDF
schema
sync
auth/security
environment/browser
```

Then make the smallest safe change that solves the actual problem.

## Do Not Touch Unrelated Areas

Do not modify Schedule, Orders, Fleet, Paperwork, Labels, Inventory, Driver Portal, DB Linen Studio, auth or sync unless the request directly requires it.

If a file is unrelated, leave it untouched.

## Schema / SQL / RLS Safety

Do not create, alter or apply database schema, migrations, SQL or RLS policies unless explicitly requested.

If SQL is requested:

- create a reviewable `.sql` file first
- do not auto-apply it from the app
- include comments and rollback considerations where appropriate
- keep it additive unless explicitly authorised

## Runtime Safety

Do not wire new systems into production behaviour until the foundation is reviewed.

For new modules:

1. add foundation/schema/helper
2. add admin shell
3. add read-only data
4. add controlled write actions
5. add automation only after approval

## Manual Override Principle

Operational workflows must support manual override.

For Rewards, the system may suggest points, but admin approval is required before points become available.

## Output Source of Truth

For printable/exportable documents:

- preview/current rendered state is the source of truth
- PDF/print/export must match that state
- do not create separate hidden logic that diverges from preview

## Build Requirement

Always run build before claiming completion:

```bash
node "node_modules/react-scripts/bin/react-scripts.js" build
```

If `npm run build` works in the environment, it may be used, but the direct React Scripts command is the known reliable fallback for this project.

## Commit and Push

After validated coding work:

```text
commit and push
```

Always provide:

- files changed
- what changed
- what was intentionally not changed
- build result
- commit SHA
- push status

---

# 3. Duchess Rewards Product DNA

## Product Definition

**Duchess Rewards** is a premium loyalty programme for Duchess & Butler clients.

It is not generic cashback.

It is not a cheap discount mechanism.

It is a private rewards and privilege experience for valued clients.

## Fundamental Promise

```text
Transform loyalty into privilege.
```

The client should feel they entered a private Duchess & Butler rewards club.

If a section feels like a supermarket points scheme, it is wrong.

## Architecture Decision

Duchess Rewards lives inside the Duchess App ecosystem but has a visually separate client-facing portal.

```text
Internal admin:
Duchess App → Duchess Rewards admin

Client portal:
/rewards/:token
```

The client portal should feel like a standalone luxury website, even though it shares the same app/repo/backend.

---

# 4. Duchess Rewards MVP Rules

## Programme Name

Use:

```text
Duchess Rewards
```

Do not use “Duchess Reward” unless specifically referring to a singular reward item.

## Point Value

```text
1 point = 0.5 pence
```

Equivalent:

```text
100 points = £0.50
1,000 points = £5.00
10,000 points = £50.00
```

## Base Reward

Initial MVP rule:

```text
3% of eligible order value
```

Since 1 point = 0.5p:

```text
£1 eligible spend = 6 points
```

Example:

```text
£1,000 eligible order value
Base reward value = £30
Base points = 6,000
```

## Hybrid Bonus Model

Duchess Rewards uses:

```text
base order value points + strategic category bonuses
```

Strategic MVP bonus categories:

- linen
- chairs
- furniture

Suggested defaults:

```text
Linen bonus: +20% of base points
Chair bonus: +15% of base points
Furniture bonus: +15% of base points
```

## Points Lifecycle

Use these states:

```text
suggested
pending
available
redeemed
rejected
cancelled
```

MVP rule:

```text
points can become available 3 days after event date, but only after admin approval
```

## Manual Approval Required

The system may calculate intelligently, but in MVP:

```text
No points become available automatically.
Admin approval is mandatory.
```

## Needs Attention

Flag records when something is unclear:

- client match uncertain
- missing eligible order value
- event date missing
- item categories unclear
- linen/chair/furniture bonus unclear
- duplicate reward suggestion possible
- order status unclear
- redemption exceeds balance

Do not hide uncertainty. Surface it clearly to admin.

---

# 5. Strategic References

Use these brands as product forces, not visual templates.

## Sephora Beauty Insider

Take:

- tier progression
- points/rewards mechanics
- “points to next tier” psychology
- reward visibility
- premium club feeling

Leave:

- cosmetics-style corporate look
- crowded grids
- pink/red palette

## Nike Membership

Take:

- confidence
- aspiration
- editorial spacing
- membership as identity
- access/status framing

Leave:

- sportswear energy
- athletic imagery
- loud all-caps tone

## Starbucks Rewards

Take:

- simplicity
- mobile-first clarity
- easy points journey
- balance-first dashboard
- quick 4-second check experience

Leave:

- casual coffee-shop warmth
- green palette
- overly friendly tone

## Synthesis

```text
Sephora = mechanics
Nike = posture
Starbucks = speed
```

---

# 6. Brand System

## Palette

Use:

```text
--charcoal:             #1A1A1A
--charcoal-soft:        #2A2A2A
--champagne:            #C9A962
--champagne-deep:       #A88845
--ivory:                #F5F1E8
--ivory-warm:           #EFE9DA
--gray-sophisticated:   #8B8680
--gray-fog:             #C8C4BD
--taupe-warm:           #B7A07A
```

Avoid:

- pure white `#FFFFFF`
- pure black `#000000`
- default Tailwind accent palettes
- blue/purple/pink/red/green accents unless explicitly required for system status

## Champagne Rule

Champagne is a status gesture, not decoration.

Use champagne for:

- tier markers
- primary CTAs
- progress fills
- selected/active state
- small highlight lines
- status accents

Do not use champagne for:

- large backgrounds
- body text
- every border
- large gradients
- generic decoration

If champagne covers more than roughly 5% of a viewport, reduce it.

## Typography

Preferred:

```text
Display: Cormorant Garamond or Playfair Display
Body/UI: Inter or Manrope
```

Do not mix multiple sans-serif families.

Do not use serif for body copy.

Do not use all-caps for large headlines unless intentionally restrained.

---

# 7. Duchess Rewards Tiers

Tier ladder:

```text
Pearl → Gold → Crown → Duchess Black
```

## Pearl

Entry tier. Calm, ivory, fresh, simple.

## Gold

Earned tier. Champagne, warm, confident.

## Crown

High-value repeat client tier. Prestige, mastery, refined ornament.

## Duchess Black

Highest prestige / invitation-only tier. Exclusive, charcoal, monolithic, private.

MVP should store tier now but should not fully automate tier upgrades yet.

---

# 8. Client-Facing Portal Rules

## Route

Future route:

```text
/rewards/:token
```

## Portal Goal

The client should understand in 4 seconds:

```text
How many points do I have?
What are they worth?
What is pending?
What tier am I?
How can I use my rewards?
```

## Visual Feeling

The portal should feel:

- luxury
- calm
- editorial
- mobile-first
- private
- simple
- premium

It should not feel:

- admin-like
- generic SaaS
- coupon-based
- discount-led
- busy

## Client Dashboard Above Fold

On mobile, above the fold should show:

1. member/client name
2. current tier
3. available points
4. reward value in pounds
5. pending points
6. primary action: `Request to Use Rewards`

## Client-Friendly Language

Use:

- member
- rewards
- privileges
- access
- tier
- earn
- redeem

Avoid client-facing language like:

- discount
- sale
- promo
- cashback
- cheap
- deal
- free
- sign up

Internal admin and technical code may still use normal terms like `loyalty_clients`, `loyalty_transactions`, and `redeem`.

---

# 9. Admin-Facing Rules

Admin screens are operational.

They should prioritise:

- clarity
- auditability
- speed
- safety
- manual approval
- needs attention visibility

Admin screens may use tables, filters, counters and technical status labels.

Do not make admin screens overly editorial at the cost of usability.

## Admin Dashboard Should Include

- enrolled clients
- available points
- pending points
- redeemed value
- needs attention count
- suggested points workflow
- client list
- setup/foundation status

## Admin Must Be Able To Eventually

- review suggested points
- approve
- adjust
- reject
- redeem points
- add manual adjustment
- copy portal link
- pause client
- regenerate token

Do not implement all of these until requested.

---

# 10. B2B / Future Commercial Surface

A future B2B “for brands” surface may exist later, but it is not the core MVP.

If built later, it can use:

- `Launch Your Program`
- `Book a Demo`
- retention metrics
- ROI language
- case studies
- brand-facing SaaS structure

Do not prioritise B2B SaaS copy inside the current Duchess & Butler client rewards MVP.

---

# 11. UI Implementation Rules

## Do Not Create Standalone HTML Pages

This is a React app.

Do not create isolated `index.html` pages unless explicitly requested.

Follow existing app structure:

- `src/pages/...`
- existing routing pattern
- existing Supabase client pattern
- existing component/style conventions where practical

## Mobile First

For client-facing rewards pages, mobile is primary.

For admin pages, desktop/tablet usability matters, but mobile should not break.

## No Fake Assets

Use real assets when available.

Do not use random external icons or emoji.

If official assets are missing, create clean placeholders only when explicitly requested and state that real assets are needed.

## Animations

Use animation sparingly.

Client-facing pages may use:

- subtle count-up numbers
- fade/slide entrance
- small button scale on hover

Admin pages should avoid unnecessary animation.

Do not use heavy animation that harms mobile performance.

---

# 12. Supabase & Data Rules

## Reads Before Writes

Prefer read-only surfaces first.

Do not add write actions until the user explicitly asks.

## No Service Key In Frontend

Never expose service-role keys or server-only secrets to frontend code.

## Token Portal

For `/rewards/:token`, token must be:

- long
- random
- non-sequential
- unique
- revocable/regeneratable by admin

Portal token should reveal only the matching client’s rewards data.

## Transactions As Ledger

Rewards should use a ledger model.

Do not overwrite balances manually without transaction history.

Balances should be computed from transactions, or stored only as derived summaries if explicitly designed later.

---

# 13. Recommended Development Workflow

Before coding:

1. inspect relevant files
2. identify exact scope
3. state assumptions
4. avoid unrelated files
5. implement surgically

After coding:

1. run build
2. test affected route/flow where possible
3. summarize changes
4. list files changed
5. confirm what was not changed
6. commit and push

---

# 14. Reporting Format After Work

Always return:

```text
Changed files
What changed
What was intentionally not changed
Validation/build result
Warnings if any
Commit SHA
Push status
```

If something could not be tested, say so clearly.

Never claim success for a test that was not run.

---

# 15. Current Known Project Behaviours

## Build

Known reliable build command:

```bash
node "node_modules/react-scripts/bin/react-scripts.js" build
```

Warnings from `dompurify` source maps and Node `fs.F_OK` deprecation may already exist and are not necessarily caused by the current task.

## Branch Safety

If the working tree is dirty or contains unrelated files:

- do not build on top of it blindly
- use a clean temporary worktree
- protect unrelated changes
- never force push

---

# 16. Hard Rules

1. Production stability beats elegance.
2. Current RMS remains source of truth.
3. Do not touch unrelated modules.
4. Do not change schema/RLS/migrations unless explicitly requested.
5. Do not wire automation before admin controls exist.
6. Do not make points available automatically in MVP.
7. Admin approval is required for Rewards availability.
8. Client portal must feel premium and separate from admin.
9. Champagne is gestural, not decorative.
10. No fake icons, emoji or random external assets.
11. Build before completion.
12. Commit and push after validated work.
13. Be surgical, specific and honest.
