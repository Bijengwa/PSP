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
