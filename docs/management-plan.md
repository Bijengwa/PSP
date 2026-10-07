# Management Plan (Office side)

Status: authoritative roadmap for the management side of PSP.
Progress: `docs/progress.md`
Detailed auth design: `docs/superpowers/specs/2026-10-06-staff-auth-design.md`
Visual reference: `PSP-Engineering-Group-Preview.html`

Order of authority, highest first:

```
docs/management-plan.md      what to build, in what order (this file)
        ↓
CLAUDE.md                    how to work
        ↓
docs/progress.md             where we are
        ↓
Claude Code                  does the work
        ↓
Mods                         guards and visibility only, never the authority
```

If this plan and the auth spec disagree, stop and ask. Do not resolve it silently.

---

## 0. Starting point (as of 2026-10-07)

Already built. Every stage below builds on this; nothing here gets rewritten.

**Backend (`node/`, JavaScript/CommonJS, Express 5, Knex, Postgres, Redis)**
- Tables `roles` and `staff_profiles` (`node/migrations/20261007100000_create_staff_auth.js`). The columns `failed_login_count`, `locked_until` and `must_change_password` exist but are not used yet.
- A seed creates the `admin` role and the first admin (`node/seeds/01_admin.js`).
- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` (`node/src/auth/auth.routes.js`).
- Redis session store: hashed session IDs, 8h sliding and 12h absolute expiry, `destroyAllForStaff` (`node/src/auth/session.store.js`). Any Redis failure becomes a 503 (fails closed).
- `requireAuth` (blocks with `PASSWORD_CHANGE_REQUIRED` while a temporary password is set), `requireRole`, `requireSameOrigin` (`node/src/auth/auth.middleware.js`).
- Structured logging with pino (`node/src/logger.js`).

**Frontend (`web/`, React 19, TypeScript, Vite, react-router)**
- `/office/auth/login` login page.
- `AuthProvider` + `useAuth()`, loaded from `/api/auth/me`. Nothing is kept in browser storage.
- `RequireAuth` guard on `/office/*`.
- `web/src/management/inApp/dashboard.tsx`: a minimal shell (sidebar with one link, top bar with name, role and a logout button).
- `web/src/api/client.ts`: the single fetch wrapper (`credentials: 'include'`).

**Not built yet:** change password, forgot password, rate limiting, lockout, staff management, permissions, audit log, event bus, theme.

---

## 1. Non-negotiable rules

### Authentication and sessions
- The session ID is opaque and lives only in the `psp_sid` cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Redis stores sessions (only the SHA-256 hash of the ID). PostgreSQL stores staff identity, role and status, and is authoritative for them.
- Staff profiles, roles and authorization decisions are **never cached**: not in Redis, not in the browser. They are read from Postgres on every request.
- Redis unavailable = management authentication fails closed (503).
- Never put auth tokens, session IDs, passwords or staff profiles in `localStorage`, `sessionStorage`, IndexedDB or non-HttpOnly cookies.
- The frontend learns who is logged in only from `GET /api/auth/me`.
- Anything that can lock a person out (deactivate, password reset, password change, role change) revokes their sessions **synchronously in the write path**.
- Never log passwords, password hashes, session IDs or reset data.

### Password and account flows (decided 2026-10-07)
- **No email or SMS delivery.** Forgot password notifies IT. IT sets a temporary password. The person must change it at next login.
- **Onboarding:** IT registers staff with a temporary password and `must_change_password = true`. The employee chooses their own password on first login. IT never knows the final password.
- Forgot password always gives the same response, whether or not the email exists.

### Scope (replanned 2026-10-07)
- Build in this order: M3.2–M3.3 → M4 IT console → M5 Products → M6 Customers → M7 Orders → C client side → H hardening. Inventory, Reports, real Notifications, online payment and customer accounts stay locked until after H8.
- Until a module's stage starts, its page stays a placeholder: a title and nothing else.
- Products, Customers and Orders ship before permissions and audit. **No real customer data goes in until H8 is signed off.**
- One roadmap step at a time. Never two at once.

### Responsiveness (every step)
- Every step that touches UI must pass at **360px, 768px and desktop**, with no horizontal scroll, before it is ticked. Tables become stacked lists on mobile.

### UI
- Clean, professional, compact, accessible, desktop and mobile, light and dark.
- No dashboard cards or statistics until the modules behind them exist.
- No emoji icons. No Tailwind unless requested. Follow the style of `PSP-Engineering-Group-Preview.html`.
- The theme preference (light/dark/system) may be stored in `localStorage`. It is not auth data.

### Files
- The user decides file and folder placement. Use existing folders (`node/src/auth/`, `node/migrations/`, `web/src/management/auth/`, `web/src/management/inApp/`). If a new file or folder is needed, propose the path and ask first.

---

## 2. Sidebar and routes

Navigation changes only through this plan. Content arrives stage by stage.

| Group | Item | Route | Until its stage |
|---|---|---|---|
| Home | Home | `/office` | simple welcome page |
| Catalog | Products | `/office/products` | placeholder until M5.2 |
| Catalog | Add Product | `/office/products/new` | placeholder until M5.3 |
| Catalog | Inventory | `/office/inventory` | placeholder (locked) |
| Sales | Orders | `/office/orders` | placeholder until M7.2 |
| Sales | Customers | `/office/customers` | placeholder until M6.2 |
| Management | Reports | `/office/reports` | placeholder (locked) |
| IT (admins only) | Staff | `/office/staff` | placeholder until M4.2 |
| IT (admins only) | Register Staff | `/office/staff/new` | built in M4.3 |
| IT (admins only) | Reset Requests | `/office/reset-requests` | moved here in M4.1 |
| System | Notifications | `/office/notifications` | "No notifications" |
| System | Settings | `/office/settings` | built in M1.7 |

Auth routes (outside the shell): `/office/auth/login`, `/office/auth/forgot-password` (M2.3), `/office/auth/change-password` (M2.1, forced and voluntary).

A placeholder page is exactly the page title in the workspace. No fake data, tables, forms or "coming soon" marketing.

The IT group is shown only to admins from M4.1. Once H5 lands, every item is shown only to people with the matching permission.

---

## 3. Shell layout

Desktop:
```
┌───────────────┬──────────────────────────────────────────────┐
│ Sidebar       │ Page title                 Notifications  Profile │
│               ├──────────────────────────────────────────────┤
│ grouped nav   │                 WORKSPACE                    │
└───────────────┴──────────────────────────────────────────────┘
```

Mobile (below the desktop breakpoint):
```
┌────────────────────────────┐
│ ☰   Page title    Notif  Avatar │
├────────────────────────────┤
│         Workspace          │
└────────────────────────────┘
```
- The sidebar is hidden by default and opens as an overlay drawer from the hamburger.
- Choosing an item, tapping outside or pressing Escape closes it. Focus moves into the drawer when it opens and back to the hamburger when it closes.

Header:
- Left: the page title (and the hamburger on mobile).
- Right: Notifications button (popover: "No notifications") and Profile button (menu: name, role, then Profile, Change password, Settings).

---

## 4. Roadmap

Each step lists **Scope** (what to do), **Done when** (checks that must pass) and **Not in this step** (the boundary).

### M1 — Management Shell

#### M1.1 Layout foundation
- **Scope:** Turn the current `dashboard.tsx` into a reusable office layout (sidebar region, header region, workspace with `<Outlet />`) mounted inside `RequireAuth`. Keep the existing auth wiring. The Home page renders inside the workspace.
- **Done when:** `/office` renders the layout with Home in the workspace. Login/logout still work. `npm run build` and `npm run lint` in `web/` pass.
- **Not in this step:** the full sidebar list, mobile behaviour, theme, new header controls.

#### M1.2 Sidebar + navigation
- **Scope:** The grouped sidebar from §2 with `NavLink` active states and routes for every item.
- **Done when:** every item navigates, the active item is highlighted, and keyboard navigation works.
- **Not in this step:** page content and the mobile drawer.

#### M1.3 Placeholder workspace pages
- **Scope:** One placeholder page per non-Home item (title only). Unknown `/office/*` paths show Not found inside the shell.
- **Done when:** each route shows its title. No placeholder fetches data.
- **Not in this step:** any real module functionality.

#### M1.4 Header
- **Scope:** Page title, Notifications popover ("No notifications"), Profile menu with data from `useAuth()` (`/api/auth/me`). The "Change password" entry routes to the M2.1 path (it may land on a placeholder until M2.2).
- **Done when:** menus open and close with mouse and keyboard, close on Escape and outside click, and have correct ARIA roles.
- **Not in this step:** real notifications, profile editing.

#### M1.5 Responsive/mobile
- **Scope:** The §3 mobile behaviour: hamburger, overlay drawer, closes on select, outside tap and Escape, focus handling, no horizontal scroll at 360px.
- **Done when:** checked at 360px, 768px and desktop widths.

#### M1.6 Dark/light theme
- **Scope:** CSS custom-property tokens for light and dark. Light/Dark/System preference stored in `localStorage` (the only allowed storage use), defaulting to System, applied before first paint to avoid a flash. Login page included.
- **Done when:** all shell and auth screens are readable in both themes and contrast meets WCAG AA.

#### M1.7 Settings + logout
- **Scope:** `/office/settings` with Appearance (Light/Dark/System, wired to M1.6), Security (link to Change password), Account (Logout). Logout calls `POST /api/auth/logout` and goes to the login page. Remove the old top-bar logout button.
- **Done when:** logging out destroys the server session (a following `/me` returns 401) and the back button cannot reach office pages.

### M2 — Authentication Completion

#### M2.1 Forced password change
- **Scope:** Change-password page at `/office/auth/change-password`. When `/me` reports `mustChangePassword`, or any API call returns 403 `PASSWORD_CHANGE_REQUIRED`, the guard sends the person there and nowhere else. Uses the M2.2 endpoint, so build the endpoint first within this step if needed.
- **Done when:** a seeded admin with a temporary password cannot reach any office page until they change it, then lands in the office.

#### M2.2 Change password
- **Scope:** `POST /api/auth/change-password` `{ currentPassword, newPassword }`, allowed while `must_change_password` is set. Password strength rules from the auth spec §7, enforced on the server and shown live in the browser (shared rule list). Clears `must_change_password`. Ends all other sessions of that person; keeps or reissues the current one.
- **Done when:** backend tests cover a wrong current password, weak passwords, same-as-current, the flag cleared, and other sessions revoked.

#### M2.3 Forgot password (request)
- **Scope:** `password_reset_requests` migration. `POST /api/auth/forgot-password` `{ email }` always returns 200 with "If this account exists, IT has been notified." It stores a request even for unknown emails (`staff_id = null`). Forgot-password page linked from login.
- **Done when:** responses for known and unknown emails are identical in body, status and roughly in timing (tested).
- **Not in this step:** email/SMS, rate limiting (M3.1).

#### M2.4 Reset password (by IT)
- **Scope:** IT's queue: `GET /api/office/reset-requests?status=pending`, `POST /api/office/reset-requests/:id/dismiss`, and `POST /api/office/staff/:id/reset-password`, which sets a strength-checked temporary password, sets `must_change_password = true`, revokes all of that person's sessions and resolves pending requests. A minimal queue page for admins. Sidebar badge with the pending count.
- **Done when:** after IT resets, the person's existing sessions stop working at once, and their next login forces M2.1.
- **Not in this step:** the full staff UI (M4).

#### M2.5 Session/security integration
- **Scope:** The API client handles 401 by returning to login with a return-to path, 403 `PASSWORD_CHANGE_REQUIRED` by going to change-password, and 503 by showing "Service temporarily unavailable" with a retry. After login the person returns to the page they asked for (only same-site `/office` paths are accepted, so there is no open redirect).
- **Done when:** frontend tests cover each redirect.

### M3 — Authentication Security

#### M3.1 Login rate limiting
- **Scope:** Redis counters from the auth spec §4: login allows 10 per IP and 5 per email per 15 min; forgot-password allows 5 per IP and 3 per email per hour; 429 when exceeded. `INCR` + `EXPIRE … NX` in one `MULTI`. Redis down → login fails closed (503).
- **Done when:** tests for the limits and the 429 response pass.

#### M3.2 Failed-login protection
- **Scope:** Use `failed_login_count` / `locked_until`. Lock for 15 min after 5 failures; a successful login resets the counter. The locked message is the same whether the password was right or wrong. Unknown emails still pay the dummy argon2 cost.
- **Done when:** lockout, unlock-after-time and reset-on-success are tested.

#### M3.3 Session revocation
- **Scope:** Audit every lock-out path that exists today (IT reset, own password change) to confirm it calls `destroyAllForStaff` synchronously. Add a "Log out of all devices" action in Settings → Account. Deactivate and role change get the same check when M4 builds them.
- **Done when:** a test proves each path ends the target's sessions on the very next request.

> Old M3.4 (Password security) and M3.5 (Cookie/proxy review) moved to **H1** and **H2** (replan 2026-10-07).

### M4 — IT Console (full circle of auth)
A new **IT** sidebar group, shown only to admins. All endpoints under `/api/office/staff` and `/api/office/reset-requests`, guarded by `requireRole('admin')` until H4 replaces that with permissions.

**M4 is done when the full circle works end to end:** IT registers a person → the person logs in with the temporary password → is forced to change it → works in the office → forgets the password → IT resets it → IT deactivates the person → the person is refused on the next request.

#### M4.1 IT sidebar group
- **Scope:** Add the IT group from §2 (Staff, Register Staff, Reset Requests). Move the M2.4 reset-request page and its pending badge into this group. Hide the group from non-admins (the server still checks every call).
- **Done when:** admins see the group, non-admins do not, and calling an IT endpoint as non-admin returns 403 (tested). Checked at 360px, 768px and desktop.

#### M4.2 Staff list
- **Scope:** `GET /api/office/staff` with search (name/email), status filter and paging. Staff table: name, email, role, status, last login. On mobile the table becomes a stacked list (no horizontal scroll).
- **Done when:** paging, search and filter are tested; no password fields in responses; responsive check passes.

#### M4.3 Register staff
- **Scope:** `POST /api/office/staff`: full name, email (lowercased, unique), phone, role, a strength-checked temporary password, `must_change_password = true`, `created_by` set. A registration form. ("Department" needs a new column; add it only if the user confirms.)
- **Done when:** duplicate emails are rejected clearly, and a new person is forced through M2.1 on first login.

#### M4.4 Staff profile
- **Scope:** Staff profile page; `PATCH /api/office/staff/:id` for name and phone. The Profile menu's "Profile" entry shows the signed-in person's own read-only profile.
- **Done when:** edits save and show, and validation errors are clear.

#### M4.5 Activate/deactivate
- **Scope:** Deactivate/reactivate through PATCH `is_active`. Deactivation revokes sessions synchronously. Rows are never deleted. An admin cannot deactivate themselves; the last active admin cannot be deactivated.
- **Done when:** a deactivated person is refused on their very next request (tested).

#### M4.6 Role assignment
- **Scope:** Change a person's role (from the existing `roles` rows). Revokes their sessions. An admin cannot remove their own admin role, and the last active admin cannot be demoted.
- **Not in this step:** new roles or permissions (H3–H5).

#### M4.7 Reset password from the profile
- **Scope:** "Reset password" on the staff profile, reusing the M2.4 service: IT enters a strength-checked temporary password and hands it over in person. Stored only as an argon2 hash, never shown or logged again. Resolves that person's pending reset requests.
- **Done when:** the M4 end-to-end circle above passes as one test (backend) plus a manual run in the browser.

### Orders vs Customers (decided 2026-10-07)

| | Customer | Order |
|---|---|---|
| What it is | A person or company PSP sells to. Long-lived. | One purchase. A snapshot of one day. |
| Type | `individual` or `company` (both are used) | — |
| Holds | Name; for companies: company name, TIN, contact person. Phone, email, addresses. | Order number, items with **price at that time**, totals, delivery address **copied** in, status, payment status, source (shop/staff). |
| Changes | Edited any time (new phone, new address). | Items and prices never change after confirmation. Only status and payment move forward. |
| Can exist alone? | Yes (walk-in, quote request, no orders yet). | Yes for shop orders: guest checkout, `customer_id` may be empty until staff link it. |
| Staff work it as | A directory: search, open, edit. | A queue: filter by status and work through it. |

Decisions: customers are both individuals and companies; the shop uses **guest checkout** (no customer accounts); payment is **pay later** (on delivery, invoice or bank transfer) and staff mark it paid. No online payment.

Order life cycle: `new` → `confirmed` → `delivered` → `closed`, or `cancelled` from `new`/`confirmed`. Payment status separately: `unpaid` → `paid`.

### M5 — Products

#### M5.1 Product data model
- **Scope:** Migrations for `product_categories` and `products` (name, slug, SKU, category, description, specs, price in TZS, `is_published`, `is_archived`, timestamps, `created_by`). Seed the categories from `PSP-Engineering-Group-Preview.html`.
- **Done when:** migrate up/down works; the user approved the fields before code.
- **Not in this step:** stock counts (Inventory comes later).

#### M5.2 Products list
- **Scope:** `GET /api/office/products` with search, category filter, published/archived filter, paging. Products page (table on desktop, stacked list on mobile).
- **Done when:** tests for search and filters pass; responsive check passes.

#### M5.3 Add product
- **Scope:** `POST /api/office/products` and the Add Product form, with server-side validation (unique SKU and slug, price > 0).
- **Done when:** invalid input gives clear field errors; a new product appears in the list.

#### M5.4 Edit, publish, archive
- **Scope:** Product detail/edit page, `PATCH /api/office/products/:id`, publish/unpublish, archive (never delete).
- **Done when:** only published, not archived products would be visible to the shop (tested at the query level).

#### M5.5 Product images
- **Scope:** Upload, order and remove product images. Storage location (local disk or cloud) is decided by the user before this step. Type and size checks on the server.
- **Done when:** images upload, show in the list and detail, and bad files are refused.

### M6 — Customers

#### M6.1 Customer data model
- **Scope:** Migrations for `customers` (type `individual`/`company`, full name, company name, TIN, contact person, phone, email, notes, timestamps, `created_by`) and `customer_addresses`. Phone/email are indexed for matching guest orders.
- **Done when:** migrate up/down works; the user approved the fields before code.

#### M6.2 Customers list
- **Scope:** `GET /api/office/customers` with search (name, company, phone, email), type filter and paging. Customers page.

#### M6.3 Add/edit customer
- **Scope:** Create and edit forms. Company fields appear only when type is `company`. Duplicate phone/email gives a warning with a link to the existing customer.

#### M6.4 Customer detail
- **Scope:** Detail page with contacts and addresses. An "Orders" section is left for M7.5 to fill.

### M7 — Orders

#### M7.1 Order data model
- **Scope:** Migrations for `orders` (number, `customer_id` nullable, guest name/phone/email/address snapshot, status, payment status, source `shop`/`staff`, totals, notes, timestamps) and `order_items` (product id, name, SKU and unit price copied in, quantity, line total). Status changes allowed only along the life cycle above (enforced on the server).
- **Done when:** invalid status jumps are refused (tested).

#### M7.2 Orders queue
- **Scope:** `GET /api/office/orders` filtered by status, payment status and source, with search by number/name/phone. Orders page with status tabs. Sidebar badge with the count of `new` orders.

#### M7.3 Order detail and status
- **Scope:** Detail page: items, totals, customer/guest details, status actions (confirm, deliver, close, cancel with a reason), mark paid.
- **Done when:** each action is tested, including refusing changes to items after confirmation.

#### M7.4 Staff-created orders
- **Scope:** Staff create an order for a phone or walk-in sale: pick or create a customer, add published products, quantities. `source = staff`. (Confirm with the user before building.)

#### M7.5 Link guest orders to customers
- **Scope:** On a shop order, suggest matching customers by phone/email. Staff link to an existing customer or create one from the order. The customer detail page lists that customer's orders.

**The staff side stops here.** Inventory, Reports and Notifications stay placeholders.

### C — Client side (public shop)
Follows `PSP-Engineering-Group-Preview.html`. **Mobile-first.** Public read endpoints live under `/api/shop/*` and return only published, not archived products. No customer accounts.

#### C1 Shop layout
- **Scope:** Public layout at `/`: header, navigation, footer, light/dark, mobile menu.
- **Done when:** checked at 360px, 768px and desktop; no horizontal scroll.

#### C2 Catalog
- **Scope:** `GET /api/shop/products` (search, category, paging). Product grid with category filter and search.

#### C3 Product page
- **Scope:** `GET /api/shop/products/:slug`. Images, description, specs, price, "Add to cart".

#### C4 Cart
- **Scope:** Cart page. The cart (product ids and quantities only, no personal data) may be kept in `localStorage`. Prices are always re-read from the server.

#### C5 Guest checkout
- **Scope:** `POST /api/shop/orders`: name, phone, email (optional), delivery address, notes. The server re-prices every line from the database and creates the order (`source = shop`, `new`, `unpaid`). Rate limited per IP. A confirmation page with the order number and "PSP will contact you to confirm and arrange payment."
- **Done when:** a tampered price in the request has no effect (tested); the order appears in the M7.2 queue.

#### C6 Shop polish
- **Scope:** Accessibility pass, page titles and meta tags, loading and empty states, image sizes for mobile data.

### H — Hardening before launch
Must be done **before real customer data goes in**. Includes everything moved out of the old M3, M5 and M6.

#### H1 Password security (old M3.4)
- **Scope:** Review argon2id parameters, the common-password list, the 1024-character cap, the "no name/email in password" rule, and that hashes and passwords never reach logs or responses.

#### H2 Cookie/proxy/security review (old M3.5)
- **Scope:** Cookie flags in production, `trust proxy` so `req.ip` is real, CORS and `requireSameOrigin`, helmet headers, error responses that leak nothing. Written in the appendix.

#### H3 Roles (old M5.1)
- **Scope:** Finalise the role list (proposed: Administrator, IT, Manager, Sales, Staff). The user approves the role matrix in this file before code.

#### H4 Permissions (old M5.2)
- **Scope:** `permissions` and `role_permissions` tables. Keys for staff and reset requests (as before) **plus** `products.*`, `customers.*`, `orders.*` and `audit.view`. Nobody can grant a role with more permissions than they hold. `/api/auth/me` returns permission keys (from Postgres, not cached).

#### H5 Permission enforcement (old M5.3)
- **Scope:** `requirePermission(key)` replaces `requireRole('admin')` on every office endpoint, including Products, Customers and Orders. Sidebar and buttons hidden by permission; the server stays the authority. No `if (role === 'IT')` checks.
- **Done when:** each endpoint returns 403 without its permission (tested).

#### H6 Audit foundation (old M6.1)
- **Scope:** `audit_logs` and the Redis Streams event bus from the auth spec §5. A failed publish is logged and never fails the request.

#### H7 Audit events (old M6.2 + M6.3)
- **Scope:** Auth and staff events as before, **plus** product changes (price, publish, archive), customer changes and order status/payment changes, with actor and target. Audit log page for `audit.view`.

#### H8 Final security review (old M6.4)
- **Scope:** Full review of auth, sessions, permissions, audit coverage, logging hygiene, and the public shop endpoints. Run `/security-review` and the code review.
- **Done when:** the user signs off. Only then is the system used with real customer data.

### Later — locked
Inventory, Reports, real Notifications, online payment, customer accounts. Each gets its own plan section, written and approved after H8.

---

## 5. Out of scope until further notice
- Email/SMS delivery of any kind (reset links, notifications)
- Two-factor authentication
- Profile picture upload (the URL column only)
- A separate worker process for bus consumers

## Appendix — Review notes
(Filled in by H2 and H8.)
