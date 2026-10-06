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
