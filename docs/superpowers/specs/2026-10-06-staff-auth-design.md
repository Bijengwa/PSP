# Staff Auth (Office side) — Design

Date: 2026-10-06
Status: Draft, awaiting review

## 1. Goal

Give the management side of PSP (the "office") a secure login. Shop customers never log in.

- Only staff log in. IT registers them; nobody can sign themselves up.
- There is one role (`admin`) today. More roles must be addable later as data rows, without changing the schema.
- Forgot password does not send an email. It notifies IT, and IT resets the password.
- Redis stores sessions; they exist nowhere else. Staff profiles and roles are **not** cached: they are read from Postgres on every request, so deactivation, forced password changes and role changes take effect immediately. Side effects (audit log, IT notification) run through an event bus on Redis Streams.

## 2. Decisions

| Topic | Decision |
|---|---|
| Frontend codebase | One React app. The public shop is at `/`, the office is at `/office/*` and is lazy-loaded. |
| Frontend language | TypeScript. Convert `web/` to `.ts`/`.tsx` before writing the auth code. |
| Backend language | Stays JavaScript (CommonJS), Express 5 + Knex + Postgres. |
| Login identifier | Email + password. Emails are unique and stored lowercase. |
| Password reset | Handled by IT. The user asks, IT sets a temporary password, and the user must change it at next login. |
| Session | A random session ID in an httpOnly cookie. The session itself is stored in Redis. |
| Session storage | Redis is the only store for sessions; they are not a cache of anything. Kept separate from the application cache in the code. |
| Application cache | Redis cache-aside for non-auth data only: the reset-request badge count in this phase, catalog data later. Staff profiles, roles and authorization decisions are never cached. All keys start with `psp:`. |
| Event bus | Redis Streams with consumer groups. |
| Redis client | `redis` (node-redis, the official client). |
| Password hashing | `argon2` (argon2id). |

## 3. Database (Postgres, Knex migrations in `node/migrations/`)

### `roles`
| column | type | notes |
|---|---|---|
| id | serial PK | |
| name | string, unique | e.g. `admin` |
| description | string | |
| timestamps | | |

### `staff_profiles`
| column | type | notes |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| full_name | string, not null | |
| email | string, unique, not null | stored lowercase |
| phone_number | string | stored in one format, e.g. `+255…` |
| password_hash | string, not null | argon2id |
| profile_picture_url | string, nullable | upload feature comes in a later phase |
| role_id | int FK → roles, not null | |
| is_active | boolean, default true | IT deactivates people; rows are never deleted |
| must_change_password | boolean, default true | |
| failed_login_count | int, default 0 | |
| locked_until | timestamptz, nullable | |
| last_login_at | timestamptz, nullable | |
| created_by | uuid FK → staff_profiles, nullable | null only for the seeded admin |
| timestamps | | |

### `password_reset_requests`
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| email | string | the email exactly as entered |
| staff_id | uuid FK, nullable | set when the email matches a staff member |
| status | enum `pending` / `resolved` / `dismissed` | |
| requested_ip | string | |
| resolved_by | uuid FK, nullable | |
| resolved_at | timestamptz, nullable | |
| created_at | timestamptz | |

### `audit_logs`
| column | type | notes |
|---|---|---|
| id | bigserial PK | |
| event_id | string, unique | the stream event ID, so the same event is never logged twice |
| type | string | e.g. `auth.login_succeeded` |
| actor_id | uuid, nullable | |
| target_id | uuid, nullable | |
| ip | string, nullable | |
| meta | jsonb | |
| created_at | timestamptz | |

### Seed
A seed creates the `admin` role and the first admin from `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `SEED_ADMIN_NAME`. That admin has `must_change_password = true`. If the admin already exists, the seed changes nothing.

## 4. Redis

### Connection and config
- Set `REDIS_URL` in `.env`, and add it to `.env.example`.
- Use two clients: one for normal commands and caching, one dedicated to the bus's blocking `XREADGROUP` reads. A blocking read ties up its connection, so it can't share one.
- Production: require a password, keep Redis off the public internet, and enable AOF persistence so sessions and stream events survive a restart.
- Set `maxmemory-policy volatile-lru`. Every cache and session key has an expiry time, and the stream has none, so the stream is never evicted. If memory runs out, an evicted session only logs that person out, so the failure is safe. Once the application cache grows (catalog phase), move it to its own Redis instance with `allkeys-lru` and run the session/bus instance with `noeviction`.
- Local development on Windows: run Redis with Docker (`redis:7`) or use Memurai.

Redis does three separate jobs here, and the code keeps them in separate modules:
1. **Session storage**: authoritative session state. Nothing is copied from Postgres.
2. **Rate limiting**: short-lived counters.
3. **Application cache**: cache-aside with TTL and invalidation, for non-auth data only. In this phase that's just the reset-request badge count. Catalog data comes later, with stampede protection.

### Session storage keys
| key | contents | TTL |
|---|---|---|
| `psp:sess:{sha256(sessionId)}` | JSON `{ staffId, createdAt, absoluteExpiresAt, ip, userAgent }` | 8h sliding (refreshed on use, at most once per minute), hard maximum of 12h |
| `psp:staff-sess:{staffId}` | SET of that staff member's session key hashes | refreshed together with the sessions |

- The raw session ID only ever exists in the cookie. Redis stores a SHA-256 hash of it, so anyone who dumps Redis cannot take over a session.
- A session holds only *who* is logged in (`staffId`). It never holds the role, `is_active` or `must_change_password`. Those are always read fresh from Postgres.

### Rate-limit keys
| key | contents | TTL |
|---|---|---|
| `psp:rl:login:ip:{ip}` | counter | 15 min |
| `psp:rl:login:email:{email}` | counter | 15 min |
| `psp:rl:forgot:ip:{ip}` / `psp:rl:forgot:email:{email}` | counter | 1h |

Counters use `INCR`, and set the expiry with `EXPIRE … NX`, both inside one `MULTI` transaction.

### Application cache keys (this phase)
| key | contents | TTL | invalidated by |
|---|---|---|---|
| `psp:reset-requests:pending-count` | integer | 60s | `reset_request.*` events (see §5) |

**Not cached, on purpose:** staff profiles, roles and authorization decisions. There is no `psp:staff:{id}` or `psp:roles` key. With only a handful of staff, a primary-key read joined to `roles` costs well under a millisecond. Caching it would let a deactivated or demoted person keep access until the TTL ran out.

### Request path
```
Request
 -> Redis: GET psp:sess:{sha256(cookie)}            (missing -> 401)
 -> Postgres: staff_profiles JOIN roles WHERE id = staffId   (primary-key lookup, every request)
 -> authorization: is_active, must_change_password, role
 -> route handler
```

A normal authenticated request costs 1 Redis `GET` and 1 indexed Postgres read.

### Session revocation
Anything that can lock a person out must take effect at once, so it happens **directly in the write path**, not through the bus:
- Deactivate, reset password, change password, or change role: delete every key listed in `psp:staff-sess:{id}`, then the set itself.
- Because profiles and roles are read from Postgres on each request, the change is already in effect for any request that slips in before the sessions are deleted. Nothing needs to be invalidated.

The bus then handles the side effects (see §5).

### When Redis is down
Sessions live in Redis, so authenticated office routes **refuse access** with 503 "Service temporarily unavailable". The public shop is not affected. `/api/health` reports the Redis status next to the database status.

## 5. Event bus (Redis Streams)

- Stream: `psp:events`, trimmed with `XADD … MAXLEN ~ 100000`.
- Event envelope: `{ id, type, version: 1, occurredAt, actorId, payload }`.
- Publishing: services call `bus.publish(type, payload, { actorId })`. A failed publish is logged but does not fail the request.
- Each consumer group reads with `XREADGROUP … BLOCK` and calls `XACK` once the event is handled. Events left unconfirmed for more than 60s are claimed again with `XAUTOCLAIM`. After 5 failed deliveries, an event goes to `psp:events:dead`.
- Handlers must be safe to run twice on the same event (idempotent). The audit handler, for example, writes with `ON CONFLICT (event_id) DO NOTHING`.

### Events
| type | published when |
|---|---|
| `auth.login_succeeded` | login succeeds |
| `auth.login_failed` | wrong password or unknown email (the payload holds the email and IP, never the password) |
| `auth.account_locked` | the lockout threshold is reached |
| `auth.logged_out` | logout |
| `auth.password_changed` | a user changes their own password |
| `staff.created` / `staff.updated` / `staff.deactivated` / `staff.reactivated` | IT manages a staff member |
| `staff.password_reset` | IT resets a password |
| `reset_request.created` / `reset_request.resolved` | forgot-password flow |

### Consumer groups
| group | does |
|---|---|
| `audit` | writes every event to `audit_logs` |
| `cache` | after `reset_request.*`, deletes `psp:reset-requests:pending-count`. It never touches sessions, which are revoked synchronously (§4). Catalog invalidation is added here later. |
| `it-notify` | after `reset_request.created`, updates the badge count. A later phase may add email or SMS to IT here. |

The consumers run inside the API process when it starts. They can move to a separate worker process later without code changes.

## 6. API (`node/src/auth/`)

All responses use the existing `{ success, data }` / `{ success, error }` format.

### Auth
| method & path | guard | notes |
|---|---|---|
| `POST /api/auth/login` | rate limit | `{ email, password }`. See §7. |
| `POST /api/auth/logout` | session | deletes the session and clears the cookie |
| `GET /api/auth/me` | session | the current staff member, read from Postgres (the same lookup `requireAuth` already did) |
| `POST /api/auth/change-password` | session (allowed even while `must_change_password` is set) | `{ currentPassword, newPassword }`. Checks password strength and ends all other sessions. |
| `POST /api/auth/forgot-password` | rate limit | `{ email }`. Always answers 200 with the same message. |

### Staff management (`requireRole('admin')`)
| method & path | notes |
|---|---|
| `GET /api/office/staff` | list, with search and paging |
| `POST /api/office/staff` | IT registers someone with a temporary password; strength is checked; `must_change_password = true` |
| `PATCH /api/office/staff/:id` | edit the name, phone, role, picture URL, or `is_active` |
| `POST /api/office/staff/:id/reset-password` | new temporary password; ends all sessions; resolves any pending request |
| `GET /api/office/reset-requests?status=pending` | IT's queue |
| `GET /api/office/reset-requests/count` | badge count, served from cache |
| `POST /api/office/reset-requests/:id/dismiss` | for example when the email doesn't belong to anyone |

### Middleware
- `requireAuth`: loads the session and staff member as in §4. Inactive accounts are refused with 401. If `must_change_password` is set, everything except `/me`, `/logout` and `/change-password` gets 403 `PASSWORD_CHANGE_REQUIRED`.
- `requireRole(...names)`: 403 if the staff member's role isn't in the list.
- `requireSameOrigin`: on POST, PATCH and DELETE, the `Origin` header must equal `CLIENT_ORIGIN`. Together with `SameSite=Lax`, this blocks forged requests from other sites (CSRF).

## 7. Security rules

- **Login:** lowercase the email and look up the staff member. If they aren't found, still run an argon2 verify against a dummy hash, so the response time doesn't reveal whether the email exists. Every failure gets the same message: "Invalid email or password".
- **Lockout:** after 5 failed attempts, `locked_until = now + 15 min` and `auth.account_locked` is published. A successful login resets the counter. A locked account gets "Account temporarily locked. Try again later or contact IT."
- **Rate limits:** login allows 10 attempts per IP and 5 per email per 15 minutes. Forgot-password allows 5 per IP and 3 per email per hour. Going over returns 429.
- **Deactivated accounts:** treated like a wrong password at login, so their existence isn't revealed. Their existing sessions were already deleted when IT deactivated them.
- **Cookie:** `psp_sid`, `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`. The session ID is 32 random bytes in base64url. Every login creates a new session ID.
- **Password strength** (the same rules run in the browser and on the server): at least 10 characters, with upper and lower case letters, a digit and a symbol. It must not contain the person's email name or a part of their full name, must not be on a small common-password list, and the new password must differ from the current one.
- **Logging:** passwords, password hashes and session IDs are never logged.
- **Forgot password:** always answers "If this account exists, IT has been notified." A request is stored even for an unknown email, with `staff_id = null`, so IT can see possible probing.
- **Self-protection:** an admin cannot deactivate themselves or remove their own admin role.

## 8. Frontend (`web/`, TypeScript)

### Setup
- Convert to TypeScript: add `tsconfig.json` and rename `main.jsx`/`App.jsx` and the management files to `.tsx`/`.ts`.
- Add `react-router` for routing and `@tanstack/react-query`, which caches API responses in the browser so the same data isn't fetched twice.

### Routes
| path | screen |
|---|---|
| `/` … | public shop (unchanged) |
| `/office/auth/login` | Login |
| `/office/auth/forgot-password` | Forgot password |
| `/office/auth/reset-password` | Set a new password: forced after IT's reset or on first login, and also reachable by choice |
| `/office/*` | guarded office area (dashboard, staff, reset requests), lazy-loaded |

The guard calls `/me` through react-query, with `staleTime` set to 5 min. Not logged in sends the person to `/office/auth/login`. With `must_change_password` set, they go to `/office/auth/reset-password`. After login, they return to the page they originally asked for.

### Login page
- Logo, a dark/light toggle (remembered in localStorage, starting from the system setting), email, password with a show/hide button, "Forgot password?", and a "Log in" button.
- The browser only checks that the email looks valid and the password isn't empty. There is no strength check at login.
- While the request runs, the button is disabled and shows a spinner, so it can't be sent twice.
- Server errors (invalid credentials, locked, 429, 503) show in one message area under the form.

### Forgot password page
- One email field. Submitting shows the same neutral confirmation every time, and a link back to login.

### Reset password page
- Fields: current password (or the temporary one), new password, and confirm. A live strength meter checks each rule from §7.
- On success, the cached `/me` data is refreshed and the person is taken into the office.

### Office area (this phase)
- **Staff list:** search, register a staff member (with the strength-checked temporary password), edit, deactivate or reactivate, and reset password.
- **Reset requests:** a pending queue with a badge in the sidebar. The count refreshes every 60s and is served from the Redis cache.
- Layout and styling follow `PSP-Engineering-Group-Preview.html`.

### Shared pieces
- A small API client using `fetch` with `credentials: 'include'`. It returns typed `{ success, data | error }` results. A 401 clears the cached `/me` data and sends the person to login.
- An `AuthProvider` and `useAuth()` hook, built on the react-query `/me` query.
- A theme provider and the dark/light toggle.

## 9. Testing

- **Backend:** Jest and Supertest against a test Postgres database and a separate Redis database number (`REDIS_URL=…/15`), flushed before each test file. Cases:
  - login succeeds and fails
  - an unknown email and a wrong password get the same response
  - lockout after 5 attempts
  - rate limit returns 429
  - an inactive account is refused
  - a forced password change blocks other routes
  - `requireRole` returns 403
  - deactivation and password reset delete sessions immediately
  - the forgot-password response is the same for known and unknown emails
  - the password strength rules
  - an authenticated request makes exactly 1 Redis session read and 1 Postgres staff/role read (asserted with a Knex query counter)
  - deactivating someone or changing their role takes effect on that person's very next request, with no waiting for a TTL
  - consumers: the audit handler writes once even when an event is delivered twice; an event left unconfirmed is claimed again
- **Frontend:** Vitest and Testing Library for:
  - route guard redirects
  - login form validation and error display
  - the strength meter rules

## 10. Out of scope (later phases)

- Self-service password reset by email or SMS
- Profile picture upload (only a URL field for now)
- Roles beyond `admin`, and finer-grained permissions
- Two-factor authentication
- A separate worker process for the bus consumers

## 11. File placement

The user decides where files go. Confirmed so far:
- Migrations: `node/migrations/`
- Backend auth: `node/src/auth/`
- Frontend auth screens: `web/src/management/auth/`
- Office screens: `web/src/management/inApp/`

To be confirmed before implementation:
- the seed file
- the Redis client
- the bus and its consumers
- staff management API code
- the shared frontend API client, auth provider and theme
- the test files
