# PSP Development Rules

PSP Engineering Group: a public shop (`/`) and a staff-only management side (`/office/*`).
- `node/`: API. JavaScript (CommonJS), Express 5, Knex + PostgreSQL, Redis. Tests: `npm test` (Jest + Supertest).
- `web/`: React 19 + TypeScript + Vite + react-router. Checks: `npm run build`, `npm run lint`.
- Visual reference: `PSP-Engineering-Group-Preview.html`.

## Management side

The authoritative roadmap is `docs/management-plan.md`.
Progress is tracked in `docs/progress.md`.
Auth design details: `docs/superpowers/specs/2026-10-06-staff-auth-design.md`.

If these documents disagree with each other or with a request, stop and ask.

### Development method

Build exactly one roadmap step at a time (e.g. M1.1, then M1.2).

Before implementation:
1. Read the step in `docs/management-plan.md` and the current state in `docs/progress.md`.
2. Inspect the existing code it touches.
3. Explain what will change and which files.
4. Confirm the work stays inside that step's Scope and outside its "Not in this step".

After implementation:
1. Run the relevant checks (`node`: `npm test`; `web`: `npm run build` and `npm run lint`).
2. Review the resulting diff.
3. Tick only that step in `docs/progress.md` and update "Current step", and only if its "Done when" checks pass.
4. Report exactly what changed and what was verified.
5. Stop.

Never continue to the next step automatically.

### Scope

Do not build real Products, Inventory, Orders, Customers, Reports or Notifications
functionality before M6.4 is signed off. Until then they are placeholder pages
showing only their title.

Do not implement more than one roadmap step at once.

### Authentication

Use the existing architecture in `node/src/auth/` and `web/src/management/auth/`.

- Opaque session ID in the HttpOnly `psp_sid` cookie (`Secure` in production, `SameSite=Lax`)
- Redis-backed server sessions; PostgreSQL is authoritative for staff identity, status and roles
- The frontend learns who is logged in only from `GET /api/auth/me`
- No auth tokens, session IDs, credentials or staff profiles in localStorage, sessionStorage or IndexedDB
- Redis failure must fail closed (503) for management authentication
- Never cache staff profiles, roles or permissions for authorization
- Revoke sessions synchronously on deactivate, password reset, password change and role change
- No email/SMS flows: forgot password notifies IT; IT sets temporary passwords; must_change_password forces a change
- Never log passwords, hashes or session IDs

### UI

Management UI must be clean, professional, compact, accessible, responsive
(desktop and mobile), and work in light and dark themes.

- No dashboard cards or statistics without real data behind them
- No emoji icons
- No Tailwind unless explicitly requested
- The theme preference is the only thing the office may store in localStorage

### Files

The user decides file and folder placement. Use the existing folders. If a new
file or folder is needed, propose the path and ask before creating it.

### Changes

- Do not modify unrelated features.
- Prefer small, reviewable changes.
- Do not install dependencies unless necessary, and say why.
- Do not rewrite working architecture without explaining why first.
