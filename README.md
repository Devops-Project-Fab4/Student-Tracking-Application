# Attendly — Student Attendance Tracking

A complete web application implementing [the attendance requirements](Student_Attendance_Tracking_Requirements.txt): FastAPI, PostgreSQL, dynamic QR check-in, role-based workspaces, classroom headcount validation, and auditable review decisions.

## Included

- **Admin:** create student/faculty accounts; edit/deactivate students; manage courses and faculty assignments; view all sessions, reports, and audit logs.
- **Faculty:** create sessions for assigned courses, enter actual headcounts, generate/rotate QR codes, review attendance, close classes, and export reports.
- **Student:** sign in, scan a QR using the phone camera or supported in-browser scanner, paste a check-in link, optionally share location, and view personal history.
- Responsive dashboard showing class strength, headcount, responses, validated attendance, under-review attendance, and absent students.
- Daily, monthly, and suspicious-attendance CSV reports; a separate activity timeline records invalid, duplicate, multi-device, and outside-classroom attempts.
- Argon2 password hashing; JWT authentication in HttpOnly cookies; role/ownership enforcement; same-origin JSON writes; rate-limited login; secure response headers; CSV formula-injection protection.
- Docker Compose deployment with a persistent PostgreSQL database, non-root app container, health checks, and an isolated test image.

## Quick start — Docker (recommended)

Requirements: Docker Desktop with Linux containers and Compose v2. From this directory:

```sh
docker compose up --build -d
docker compose exec app python -m app.seed
```

Open **http://localhost:8000**. API documentation is at **http://localhost:8000/docs**.

If port 8000 is occupied, set `APP_PORT=8080` and `PUBLIC_URL=http://localhost:8080` in your local `.env`, then start the stack and open **http://localhost:8080**. This workspace's initial local setup uses **8080** because another application already occupies 8000.

Seeding is **explicit, development-only, and requires an empty database**. It does not run automatically or overwrite existing records. On subsequent starts, use only `docker compose up -d`.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Admin | admin@example.com | AttendlyDemo!2026 |
| Faculty | faculty@example.com | AttendlyDemo!2026 |
| Student (not yet checked in) | student60@example.com | AttendlyDemo!2026 |

Students 01–60 are available at `student01@example.com` through `student60@example.com`, with the same **demo-only** password. Never use these accounts on a public deployment.

The seeded class has **60 students, headcount 55, responses 57, present 55, under review 2, absent 3**. Its check-in window ends four hours after seeding. Create a new session when it expires. Student 60 can submit a new scan; since capacity is already full, this additional response will go under review.

Useful lifecycle commands:

```sh
docker compose ps
docker compose logs --tail=100 app
docker compose down
```

Stopping the stack preserves database data. **Do not use `down -v` unless intentionally deleting all attendance data.**

## Local Python development

Python **3.13 or newer**; no Node.js build pipeline is required. The vanilla JavaScript/CSS frontend is served directly by FastAPI.

```sh
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m app.seed
uvicorn app.main:app --reload --port 8000
```

Without `DATABASE_URL`, direct Python development uses a local SQLite database. Docker always configures PostgreSQL. SQLite is a convenient development fallback, not the recommended production database.

Copy [.env.example](.env.example) to a local `.env` to override settings. Environment files and database files are ignored by Git and excluded from Docker images. An empty development `JWT_SECRET` creates a temporary signing key; restarting the app signs out existing users. Set a stable random secret for sessions that should survive restarts.

### Start without demo data

On a fresh database, configure `BOOTSTRAP_ADMIN_EMAIL` and a `BOOTSTRAP_ADMIN_PASSWORD` of at least 12 characters before starting the app. The initial administrator is created only when no administrator exists. Then:

1. Add faculty under **Courses → Add faculty**.
2. Add students under **Students**.
3. Add courses, selecting department, semester, and faculty.
4. Create a class session. Matching active students are copied into a fixed session roster.
5. Count the actual students, set the headcount, and generate the QR during the session window.
6. Students sign in and check in. Staff review flagged records and close the class.

## QR and validation semantics

### Shared QR, one redemption per student

A displayed classroom QR must be usable by every enrolled student. Therefore **one-time** means **one successful redemption per authenticated student per session**, enforced by a database uniqueness constraint. It does not mean the first student globally consumes the classroom code.

- QR payloads contain a cryptographically random 256-bit token. Only its SHA-256 hash is stored.
- Tokens expire after **five minutes**, or at class end if sooner.
- Rotating a QR immediately invalidates the previous token. Closing a class invalidates its QR.
- The token is in the URL **fragment**, not the query string, so it is not sent in page-request access logs. The frontend clears the fragment after reading it.
- QR generation and submission are restricted to the session's start/end window.
- Student identity comes from the signed-in account, never a student ID supplied by the scanner.

### Reconciliation

1. **No headcount:** valid submissions remain `UNDER_REVIEW` until staff enters the count.
2. **Within capacity:** unflagged submissions are marked `PRESENT`, in server-recorded arrival order.
3. **Over capacity:** additional submissions stay `UNDER_REVIEW`; they are never automatically approved above headcount.
4. **Risk signals:** shared-device, multi-device, and location signals require review even when capacity is available.
5. **Manual decisions:** staff can approve a record only with free headcount capacity, or block it with a reason. Approved decisions get priority on subsequent reconciliation; reducing headcount still caps approvals. Blocking is preserved when headcount changes.
6. Database session-row write locks serialize scan/headcount/review changes; unique constraints prevent duplicate records.

**Important:** the last two responses are capacity-based review candidates, not proven fraudulent students. Arrival order, a device identifier, IP address, and self-reported GPS cannot establish who was physically present. A faculty member must resolve a mismatch using classroom evidence. Verified headcount is trusted input and changes are audited.

### Status meanings

| Status | Meaning |
| --- | --- |
| `PRESENT` | Validated within headcount capacity |
| `UNDER_REVIEW` | No headcount, capacity exceeded, or unresolved risk signal |
| `ABSENT` | No attendance row, or no accepted participation after a blocked record; the blocked record itself retains its status |
| `BLOCKED` | Staff explicitly rejected the attendance record |
| `INVALID_QR` | Rejected attempt in fraud logs; not counted as a response |
| `DUPLICATE` | Rejected repeat redemption in fraud logs; not counted as another response |

`MULTI_DEVICE`, `SHARED_DEVICE`, `EXCESS_ATTENDANCE`, and `OUTSIDE_CLASSROOM` are additional audit signal types. A repeat redemption from a new device flags the existing record rather than creating a second one. Shared-device checks flag **both** student records. Shared IP alone is not treated as fraud because campus networks commonly use NAT.

The dashboard's absent count is `strength − present − under_review`, so blocked students count as absent. During an open class, absence is provisional; student history labels an unsubmitted open session as **Not checked in**. Report date boundaries use **UTC**; UI session times display in the browser's local timezone.

## Phone access and camera support

The default stack is deliberately bound to **127.0.0.1**. For student phones:

1. Put the app behind an HTTPS reverse proxy on a reachable campus hostname.
2. Set `PUBLIC_URL` to that exact public origin, without a path (for example, `https://attendance.example.edu`). Generated QRs and same-origin write checks use this value.
3. Enable `COOKIE_SECURE=true` and `ENVIRONMENT=production`; set strong unique secrets.
4. Open the site on the phone and sign in, then scan the faculty QR using the phone's native camera.

In-browser scanning uses `BarcodeDetector` where available. Unsupported browsers always have the **native phone camera / paste link** fallback. Camera, clipboard, and geolocation APIs generally require HTTPS or localhost. Optional classroom boundaries require all three session settings: latitude, longitude, and radius. Missing or outside-boundary GPS is flagged for review, not silently accepted. Client device identifiers can be reset and GPS can be spoofed; these are advisory signals.

## Tests and build

```sh
python -m pytest -q
python -m ruff check app tests
node --check app/static/app.js   # optional JS syntax check if Node is installed
docker compose --profile test build test
docker compose --profile test run --rm test
docker compose build app
```

Tests cover the 60/55/57 scenario, expired/rotated tokens, duplicate and multi-device scans, shared devices, geofence signals, concurrent capacity enforcement, review decisions, zero/missing headcounts, session windows, immutable rosters, roles and faculty isolation, JWTs, CSRF guards, login limits, reports, CSV injection, and static assets.

Optional browser regression tests require Node.js and a freshly seeded running demo:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
# If using port 8080 (bash/WSL):
E2E_BASE_URL=http://localhost:8080 npm run test:e2e
```

Browser tests cover desktop/mobile layouts, role-based navigation, forms, QR rendering, review filters, CSV downloads, personal history, and invalid check-in handling. They rotate the demo QR and add a rejected attempt to the activity log, but do not change attendance counts. Screenshot/trace artifacts are saved in the ignored test-results directory. Some Linux distributions also require `npx playwright install-deps chromium`.

By default tests use disposable SQLite databases, never the application database. To run against PostgreSQL, set **`TEST_DATABASE_URL` to a dedicated, empty, disposable test database**. The test fixture creates and drops its tables. Never point this variable at the application database.

## Architecture

```text
Browser (responsive HTML/CSS/JavaScript)
	├─ Admin / faculty / student views
	├─ Camera / QR-link capture
	└─ Same-origin JSON API + HttpOnly JWT cookie
									│
FastAPI application
	├─ Authentication and role/ownership checks
	├─ QR generation and five-minute token validation
	├─ Attendance reconciliation and review
	└─ CSV reporting and audit trails
									│
SQLAlchemy → PostgreSQL
```

Key tables: `users`, `students`, `courses`, `class_sessions`, `session_students`, `attendance`, `fraud_logs`, `audit_logs`, and `login_attempts`.

| File | Purpose |
| --- | --- |
| [app/main.py](app/main.py) | API, authorization, QR, reports, app lifecycle |
| [app/models.py](app/models.py) | Database schema and constraints |
| [app/services.py](app/services.py) | Locking, reconciliation, distance calculation |
| [app/security.py](app/security.py) | Password hashing and JWT validation |
| [app/schemas.py](app/schemas.py) | Request validation |
| [app/static/app.js](app/static/app.js) | Role-based frontend |
| [app/static/styles.css](app/static/styles.css) | Responsive visual design |
| [app/seed.py](app/seed.py) | Explicit demo initialization |
| [tests](tests) | Integration and security regression tests |
| [compose.yaml](compose.yaml) | PostgreSQL + app + test deployment |

## Production checklist and boundaries

- Use HTTPS, `ENVIRONMENT=production`, `COOKIE_SECURE=true`, an exact `PUBLIC_URL`, and a randomly generated `JWT_SECRET` with at least 32 characters. Startup rejects insecure production cookie/URL/signing settings.
- Replace the development database password. URL-encode reserved characters if placing credentials in `DATABASE_URL`; the Compose interpolation expects a URL-safe password.
- Start with a fresh database and bootstrap admin credentials, **not demo accounts**. Remove bootstrap credentials after initial provisioning.
- Do not expose the PostgreSQL port publicly. Keep database backups, test restoration, and define retention/access policies for student records, IP addresses, locations, and logs.
- One app worker is configured by default. Use a stable shared signing key before adding workers. Database locks enforce per-session consistency on PostgreSQL.
- Proxy headers are disabled by default to prevent spoofed client IPs. Behind a trusted proxy, explicitly configure Uvicorn's trusted forwarding settings; otherwise IP logs and IP-based limits reflect the proxy. Add edge rate limiting for public deployments.
- JWT sessions last eight hours. Logout clears the browser cookie; there is no token revocation list. Deactivating a student prevents access immediately because account status is checked on every authenticated request.
- Initial schema creation is automatic. Future schema changes require a controlled migration process and backups; automatic table creation does not migrate existing columns.
- Demo-scale endpoints return complete rosters/reports and use straightforward queries. Add database-side aggregation/pagination for large institutions; validation/audit views currently display the latest 500 events.
- Account recovery, email invitations, password-reset flows, face recognition, and AI fraud identification are not included. Assignment tracking is not part of the supplied attendance requirements.
