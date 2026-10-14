# Management Progress

Plan: `docs/management-plan.md`. Tick a box only when that step's "Done when" checks pass.
UI steps also need the responsive check (360px, 768px, desktop) before ticking.
Replanned: 2026-10-07. Re-ordered 2026-10-14 (shop first): M5.6 → C2 → C3 → C4 → C5 → C6 → C7, then back to M4.1.
M4.1–M4.3 ticked on 2026-10-14 at the user's instruction after a code check (see `docs/overnight-log.md` for the checks still open).
Overnight order after M4.8: M6.1 → M6.2 → M6.3 → M6.4 → M7.1 → M7.2 → M7.3 → M7.5, then Current step is set to M7.4 (needs the user) and the run stops.
Current step: **M6.3**

## M1 — Management Shell

- [x] M1.1 Layout foundation
- [x] M1.2 Sidebar + navigation
- [x] M1.3 Placeholder workspace pages
- [x] M1.4 Header
- [x] M1.5 Responsive/mobile
- [x] M1.6 Dark/light theme
- [x] M1.7 Settings + logout

## M2 — Authentication Completion

- [x] M2.1 Forced password change
- [x] M2.2 Change password
- [x] M2.3 Forgot password
- [x] M2.4 Reset password
- [x] M2.5 Session/security integration

## M3 — Authentication Security

- [x] M3.1 Rate limiting
- [x] M3.2 Failed-login protection
- [x] M3.3 Session revocation

## M5 — Products

- [x] M5.1 Product data model
- [x] M5.2 Products list
- [x] M5.3 Add product
- [x] M5.4 Edit, publish, archive
- [x] M5.5 Product images
- [x] M5.6 Products completion (verify M5.1–M5.5, UI/UX, responsive check tool)

## C — Client side (public shop)

- [x] C1 Shop layout
- [x] C2 Catalog
- [x] C3 Product page
- [x] C4 Cart
- [x] C5 Orders tables and checkout API
- [x] C6 Checkout page
- [x] C7 Shop polish

## M4 — IT Console (full circle of auth)

- [x] M4.1 IT sidebar group
- [x] M4.2 Staff list
- [x] M4.3 Register staff
- [x] M4.4 Staff profile
- [x] M4.5 Activate/deactivate
- [x] M4.6 Role assignment
- [x] M4.7 Reset password from the profile (end-to-end circle)
- [x] M4.8 M4 checks and end-to-end circle

## M6 — Customers

- [x] M6.1 Customer data model
- [x] M6.2 Customers list
- [ ] M6.3 Add/edit customer
- [ ] M6.4 Customer detail

## M7 — Orders

- [ ] M7.1 Order data model
- [ ] M7.2 Orders queue
- [ ] M7.3 Order detail and status
- [ ] M7.4 Staff-created orders
- [ ] M7.5 Link guest orders to customers

## H — Hardening before launch

- [ ] H1 Password security (old M3.4)
- [ ] H2 Cookie/proxy/security review (old M3.5)
- [ ] H3 Roles (old M5.1)
- [ ] H4 Permissions (old M5.2)
- [ ] H5 Permission enforcement (old M5.3)
- [ ] H6 Audit foundation (old M6.1)
- [ ] H7 Audit events (old M6.2 + M6.3)
- [ ] H8 Final security review (old M6.4)
