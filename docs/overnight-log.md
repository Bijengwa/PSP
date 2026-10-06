# Overnight Log

## 2026-10-07 — M1.1 Layout foundation

**Changed**
- `web/src/management/inApp/dashboard.tsx`: the default export `Dashboard` is now `OfficeLayout`. It keeps the sidebar region, the header region (name, role, Log out) and the logout error alert. The workspace (`<main className="office-main">`) now renders `<Outlet />`. The sidebar link label changed from "Dashboard" to "Home".
- Same file: new named export `OfficeHome`, the Home page with the "Home" title and "Welcome, {fullName}." text.
- `web/src/App.tsx`: inside `RequireAuth`, a layout route `<OfficeLayout />` wraps the index route `<OfficeHome />`. Both are lazy-loaded from the same office chunk. The `/office/*` catch-all `NotFound` stays outside the layout (it moves into the shell in M1.3).

**Not changed**
- Auth wiring: `AuthProvider`, `RequireAuth`, `login.tsx`, `api/client.ts` and the backend. No CSS, no new dependencies.

**Verified**
- `npm run build` (web): passed.
- `npm run lint` (web): passed, no warnings.
- `node` tests: not run, because there were no backend changes.
- Login and logout were checked only by reading the code. No browser run was done: the login, redirect and logout code paths are untouched, and the Log out button still calls `useAuth().logout()`.

**Notes for the user**
- `OfficeHome` lives in `dashboard.tsx` so that no new file had to be created without approval. If you want it in its own file (for example `web/src/management/inApp/home.tsx`), say where, and it can be moved in a later step.
- Next step: M1.2 Sidebar + navigation. It was not started.

## 2026-10-07 — M1.2 Sidebar + navigation

**Changed**
- `web/src/management/inApp/dashboard.tsx`: a `NAV_GROUPS` list holds the §2 groups and items (Home; Catalog: Products, Add Product, Inventory; Sales: Orders, Customers; Management: Staff, Reports; System: Notifications, Settings). The sidebar renders one labelled `<ul>` per group (an `h2` heading tied to the list with `aria-labelledby`), with a `NavLink` per item. Every link uses `end`, so Products is not highlighted on `/office/products/new`.
- `web/src/App.tsx`: element-less child routes inside `OfficeLayout` for `products`, `products/new`, `inventory`, `orders`, `customers`, `staff`, `reports`, `notifications`, `settings`. Each renders the shell with an empty workspace, because page content belongs to M1.3. Unknown `/office/*` paths still hit the old full-page NotFound (it moves into the shell in M1.3).
- `web/src/index.css`: styles for group headings (`.office-nav-heading`) and lists (`.office-nav-list`), a hover state for `.office-nav-link`, and links set to `display: block`. The active style (`.active`, set by `NavLink` along with `aria-current="page"`) is unchanged.

**Not changed**
- Auth wiring, the header and logout, the backend. No mobile drawer (M1.5), no page content (M1.3). No new files or dependencies.

**Verified**
- `npm run build` (web): passed.
- `npm run lint` (web): passed, no warnings.
- `node` tests: not run, because there were no backend changes.
- The "Done when" items (every item navigates, the active item is highlighted, keyboard navigation works) were checked **only by reading the code**. No browser run was done, and a small runtime check script could not be run because writing outside the project needs a permission this session does not have. Reasoning: each sidebar path has a matching route inside the layout. The links are real `<a>` elements in document order, so Tab, Shift+Tab and Enter work, and the global `:focus-visible` outline shows focus. `NavLink` sets `.active` and `aria-current="page"` on the current item. A quick manual click-through in the browser is still worth doing.

**Notes for the user**
- At the start, a Collision Guard hook said another session (78b38214) had edited `dashboard.tsx`, `App.tsx` and these docs a few minutes earlier. `git status` showed a clean tree apart from this step's own edits, so it was taken to be the committed M1.1 work.
- On narrow screens (≤768px) the full sidebar list currently stacks above the workspace. This is expected until the M1.5 drawer.
- Next step: M1.3 Placeholder workspace pages. It was not started.

## 2026-10-07 — M1.3 Placeholder workspace pages

**Changed**
- `web/src/management/inApp/dashboard.tsx`: two new named exports.
  - `PlaceholderPage({ title })` renders only `<h1 className="office-title">{title}</h1>`.
  - `OfficeNotFound` shows a "Not found" title, one line of text and a link back to Home (`/office`).
- `web/src/App.tsx`: each sidebar route (`products`, `products/new`, `inventory`, `orders`, `customers`, `staff`, `reports`, `notifications`, `settings`) now renders `PlaceholderPage` with its sidebar label as the title. The `/office/*` catch-all moved inside `OfficeLayout` and now renders `OfficeNotFound`, so unknown office paths show inside the shell and stay behind `RequireAuth`. The top-level `*` NotFound for non-office paths is unchanged. Both new components are lazy-loaded from the office chunk, like `OfficeHome`.

**Not changed**
- The sidebar, header, logout, auth wiring, CSS and backend. No new files or dependencies.

**Verified**
- `npm run build` (web): passed.
- `npm run lint` (web): passed, no warnings.
- `node` tests: not run, because there were no backend changes.
- "No placeholder fetches data": `PlaceholderPage` and `OfficeNotFound` are plain render functions with no hooks, effects or API calls.
- "Each route shows its title": checked by reading the code (each route passes the matching title). No browser run was done.

**Notes for the user**
- §2 lists Notifications as `"No notifications"` until its stage, but the M1.3 scope says "title only". The page currently shows only the title "Notifications". If you want the "No notifications" line added on the page too, say so. The M1.4 header popover will show "No notifications" either way.
- The Collision Guard hook again flagged a recent edit by another session (28d23d15). Re-reading the files showed only this step's edits on top of the committed M1.2 work, so nothing was overwritten.
- Next step: M1.4 Header. It was not started.

## 2026-10-07 — M1.4 Header

**Changed**
- `web/src/management/inApp/dashboard.tsx`:
  - The header now has the page title on the left. It is looked up from the current path (sidebar labels, plus "Change password"; anything else shows "Not found"). It is a `<p>`, not a heading, because each workspace page already has its own `h1`.
  - `NotificationsPopover`: a bell icon button (inline SVG, `aria-label="Notifications"`, `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`) opens a non-modal `role="dialog"` popover that says "No notifications". Focus moves into the popover when it opens.
  - `ProfileMenu`: the avatar, name and role button (`aria-haspopup="menu"`, `aria-expanded`, `aria-controls`) opens a menu. It shows name and role from `useAuth()`, then a `role="menu"` list with `role="menuitem"` entries: Profile, Change password (routes to `/office/auth/change-password`) and Settings (routes to `/office/settings`). Keyboard: ArrowDown/ArrowUp on the button open the menu on the first/last item; ArrowUp/Down (wrapping), Home and End move between items; Enter activates.
  - Both popovers close on Escape (focus returns to the button), on a pointer press outside, when focus is tabbed out, and when the button is clicked again. Opening one closes the other, because that click counts as outside.
  - New exported constant `CHANGE_PASSWORD_PATH`.
  - The Log out button stays in the header until M1.7 moves it to Settings.
- `web/src/App.tsx`: a placeholder route `auth/change-password` ("Change password") inside the shell, so the menu entry lands on a placeholder until M2.1/M2.2 replace it.
- `web/src/index.css`: header title and actions, icon/profile buttons, popover, menu and disabled-item styles. The unused `.office-user` rule was removed.

**Not changed**
- Auth wiring, the backend, the sidebar and the placeholder pages. No real notifications, no profile editing, no mobile drawer. No new files or dependencies.

**Verified**
- `npm run build` (web): passed.
- `npm run lint` (web): passed. The first run flagged `react-hooks/refs`, because refs were passed into a helper during render. This was fixed by using `event.currentTarget` in the blur handler instead.
- `node` tests: not run, because there were no backend changes.
- The "Done when" checks (open and close with mouse and keyboard, Escape, outside click, ARIA roles) were checked **by reading the code only**. No browser run was done: the session could not check whether Postgres and Redis were running without extra approval. A manual check in the browser is still worth doing.

**Notes for the user**
- **Profile** is shown in the menu as a disabled item (`aria-disabled`), because the own-profile page belongs to M4.3 and §2 has no route for it. If you would rather hide it until M4.3, or point it somewhere, say so.
- The change-password placeholder renders *inside* the shell. M2.1 builds the real page outside the shell, as §2 says, and will need to move this route.
- The header title repeats the workspace `h1` on each page, because the plan asks for both. On narrow screens the profile button still shows the full name; the compact mobile header is M1.5.
- The Collision Guard hook again reported recent edits by other sessions (80b8c5fd, 28d23d15). `git status` showed only this step's changes, so nothing was overwritten.
- Nothing was committed.
- Next step: M1.5 Responsive/mobile. It was not started.
