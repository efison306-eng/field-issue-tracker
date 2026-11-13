# Offline Field Issue Tracker

Field workers report infrastructure problems (broken water points, damaged equipment, safety concerns…) from a phone or laptop, **even with no connectivity**. Reports are saved on the device first and synchronize automatically when the network returns. A coordinator reviews reports and moves them through a status workflow.

Zero runtime dependencies: Node's built-in HTTP server and SQLite on the backend, vanilla ES modules + IndexedDB + a service worker on the frontend.

## Run it

Requires **Node.js 22.5 or newer** (uses the built-in `node:sqlite`).

```bash
npm run seed     # optional: loads 6 demo reports into data/tracker.sqlite
npm start        # http://localhost:3000   (PORT and DB_PATH env vars are supported)
```

No `npm install` is needed.

### Run the tests

```bash
npm test
```

44 tests, about a second, no network and no browser needed. They start the real HTTP server on a random port with an in-memory database.

### Try the offline flow

1. Open http://localhost:3000 and tick **Simulate offline** in the header (it makes every request fail like a dead network; DevTools → Network → Offline also works).
2. Create a report. It appears immediately with a **Pending** chip. Reload the page: it is still there.
3. Untick **Simulate offline**. The report syncs on its own and turns **Synchronized**.
4. Switch **Role** to *Coordinator*, open the report and move it through the workflow. Try an invalid move, or reopen without a note, and see the refusal.

## Architecture

```
public/            browser app (no build step)
  js/core.js         offline-first logic + sync engine  (pure, unit-tested)
  js/store.js        IndexedDB store (+ in-memory twin for tests)
  js/api.js          fetch wrapper that classifies failures
  js/app.js          DOM/UI only
  sw.js              service worker: caches the app shell so it opens offline
shared/domain.js   statuses, transitions, permissions, validation (used by BOTH sides)
server/
  app.js             HTTP routing, validation, workflow, history
  db.js              SQLite schema + helpers
  seed.js            demo data
test/              node:test suites (domain, API over real HTTP, sync engine)
```

**Two copies of the data, one rule set.** The device holds a local copy of every report in IndexedDB; the server holds the authoritative copy in SQLite. `shared/domain.js` is imported by both sides, so the client and server cannot disagree about what is valid.

**Data model.** `reports` (id, category, description, location, priority, status, reported_at, received_at, updated_at, `version`, created_by, fingerprint) and an append-only `history` table (type, actor, message, JSON detail). Locally each report also carries `syncState`, `attempts`, `lastError` and an `activity` log.

### API

| Method & path | Purpose |
|---|---|
| `POST /api/reports` | Idempotent create (keyed by client-generated id). `201` new, `200` already stored |
| `GET /api/reports[?status=]` | List reports |
| `GET /api/reports/:id` | One report |
| `PATCH /api/reports/:id` | Edit content; requires `baseVersion` |
| `POST /api/reports/:id/status` | Workflow transition `{status, note?, expectedStatus?}` |
| `GET /api/reports/:id/history` | Server-side activity history |
| `GET /api/health` | Liveness |

Errors are always `{ "error": { "code", "message", ...extra } }` with `400/403/404/409/413/422/500`.

### Synchronization strategy

| Concern | Decision |
|---|---|
| **Identity / duplicates** | The *client* generates a UUID when the report is created. `POST /api/reports` is idempotent on that id: a second POST of the same id returns the stored report (`200`, `duplicate: true`) and never inserts again. Any retry is therefore safe, including the case where the server stored the report but the response was lost. |
| **States** | `local` (draft, never synced) → `pending` → `syncing` → `synced` or `failed`. |
| **When it runs** | On app start, on the browser `online` event, when the tab becomes visible, every 20 s, after saving, and on the *Sync now* button. Overlapping triggers share one in-flight run. |
| **Network failure** | The report stays `pending` (not failed) and the run stops, since the rest would fail too. Network errors never count towards a retry limit: being offline is not the report's fault. |
| **Server 5xx / 408 / 429** | Stays `pending` for up to 5 attempts, then `failed` so it is visible. |
| **Validation (4xx)** | Goes to `failed` immediately with the server's reason. It is *not* auto-retried (it would fail the same way). The user edits the report, which re-queues it, or presses *Retry sync*. |
| **Interrupted sync** | A report is marked `syncing` before the request. If the app dies mid-request, it is found in `syncing` on next start and reset to `pending`. Idempotent creates make the re-send safe. |
| **No silent loss** | Nothing is ever deleted locally. A locally-created report that the client believes is synced but that is missing from the server's list (for example after a server restore from backup) is re-queued as `pending`. |
| **Merging server data** | After each sync the client downloads the list and merges it. Server data overwrites local copies that are already `synced`; local work that has *not* synced yet is never overwritten. |

### Status workflow

| From | To | Who |
|---|---|---|
| Draft | Submitted | worker (local; drafts never reach the server) |
| Submitted | Assigned, Rejected | coordinator |
| Assigned | In Progress, Rejected | coordinator |
| In Progress | Resolved, Assigned (reassign) | coordinator |
| Resolved | In Progress (**reopen**) | coordinator |
| Rejected | Submitted (resubmit after fixing) | worker or coordinator |

Everything else is refused: `409 invalid_transition` (with the list of allowed moves), `403 forbidden_transition` for a worker attempting a coordinator move, and `422 note_required` for Reject or Reopen without a note.

## Assumptions and design decisions

1. **Roles are simulated.** The UI sends `X-Role` and `X-Actor` headers. The server treats an unknown role as `worker`. This is *not* security; it only demonstrates the permission model.
2. **Drafts are local-only.** The server only accepts new reports as `Submitted`. A draft is the worker's private scratchpad, so it is never shared half-finished and never appears on a coordinator's screen.
3. **Reopening a resolved issue reuses the same report** (`Resolved → In Progress`, note required) instead of creating a new one, so the whole history stays in one place.
4. **Editing after submission.** Content (category, description, location, priority) is editable only while the report is `Submitted` or `Rejected`. Once a coordinator has `Assigned` it, content is locked, because someone may already be acting on it. Status, id and reported time can never be edited. Edits to a report that is already on the server use **optimistic concurrency**: the client sends `baseVersion`; if the server's version has moved on, the edit is refused with `409` and the client adopts the server copy. Edits to a report that has *not yet synced* are local and unrestricted.
5. **Status changes and edits of server-side reports need a connection.** Letting coordinators queue status changes offline would need a conflict-resolution scheme (two people moving the same report), which I judged out of scope. The UI says so instead of failing silently. Creating reports, the field worker's real need, works fully offline.
6. **Stale status changes** are refused (`409 stale_status`) when the client's `expectedStatus` no longer matches, so two coordinators cannot silently overwrite each other.
7. **Duplicate *content* (two workers reporting the same pump).** Detected softly: same category + normalised location + normalised description within 24 h. The report is **kept** (a false positive must not lose a real report) and a `duplicate_suspected` event is added to its history for a coordinator to see. Rejecting as a duplicate is a coordinator decision.
8. **Time.** `reportedAt` is the device clock at creation, and is rejected if more than 5 minutes in the future. The server also records `received_at` from its own clock, so clock skew is visible rather than hidden.
9. **Data safety.** All SQL is parameterised. Text is stored verbatim and the UI renders it with text nodes (never `innerHTML`), so hostile input is displayed, not executed. Bodies over 100 KB, malformed JSON, control characters, oversized fields and path traversal on the static server are all rejected.
10. **History.** The server logs created, edited (with before/after), status changes (who and why), suspected duplicates, retried creates, and refused operations. The device logs its own view: saved, sync attempts, failures, retries. The detail screen shows both.

## Testing priorities

Highest risk first:

1. **Sync correctness** (`test/core.test.js`): offline stays pending and nothing is lost; a lost response does not duplicate on retry; validation failure → `failed` → fix → synced; bounded retries on 5xx; recovery from a crash mid-sync; overlapping triggers; no clobbering of unsynced local data.
2. **Server idempotency and data integrity** (`test/api.test.js`): the same id never inserts twice, a retry with different text never overwrites, hostile input, validation, 400/413/404 paths.
3. **Workflow rules** (`test/domain.test.js` + API tests): every valid move works, invalid ones are refused, role permissions, required notes, stale status and stale version conflicts.
4. **History** is asserted wherever an action happens, including for refused actions.

Not covered by automated tests: the DOM layer and the service worker (see the manual checklist). They hold almost no logic by design.

## Manual QA checklist

- [ ] Create a report with **Simulate offline** on → card shows *Pending*; reload → still there.
- [ ] Stop the server, reload the page → app shell loads and reports are listed.
- [ ] Turn the network back on → report becomes *Synchronized* by itself (instantly on the `online` event, otherwise within ~20 s).
- [ ] Stop the server mid-sync, restart it → report syncs once; `GET /api/reports` has exactly one copy.
- [ ] Submit a form with a 1-character description → inline errors, nothing saved.
- [ ] Save as draft → *Local draft*, absent from `GET /api/reports`; *Submit* from detail → syncs.
- [ ] As a worker, open a *Submitted* report → no triage buttons. As coordinator → Assign / Reject.
- [ ] Reject or Reopen with an empty note → refused.
- [ ] Walk Submitted → Assigned → In Progress → Resolved → Reopen; check *Activity on the server*.
- [ ] Open the same report in two tabs as coordinator; change status in one, then try in the other → refused, UI shows the new state.
- [ ] Edit a *Submitted* report online → saved; an *Assigned* one → no Edit button.
- [ ] Description `<script>alert(1)</script>` → shown as text, nothing runs.
- [ ] Phone: layout is usable at 360 px wide; buttons are at least 44 px tall.

## Known limitations

- No authentication; roles are cosmetic.
- Status changes by coordinators are online-only (assumption 5).
- No pagination: the full list is downloaded on every refresh (fine for hundreds of reports, not hundreds of thousands).
- Sync is polling-based; there is no server push.
- Soft-duplicate detection is exact-after-normalisation, not fuzzy.
- Only the latest 100 local activity entries per report are kept.
- Photos and GPS capture are not implemented (location is free text).
- The service worker caches the shell on the first visit only, so the very first visit needs a connection.
- Browser storage can be evicted under extreme storage pressure; `navigator.storage.persist()` is not requested.
- The reported time is the device's clock, which may be wrong in the field.

## Time spent and what I would improve

*(Fill in your own numbers.)* Approximate time: **___ hours**.

With more time: queue coordinator actions offline with proper conflict resolution; add a real login; capture GPS and photos; add a Playwright end-to-end suite for the offline flow; fuzzy duplicate detection; pagination and `since`-based incremental sync; an exponential back-off schedule; Background Sync where supported.

## AI and development-tool disclosure

> **Edit this section so it is true for you.** The brief requires you to say what you used AI for, what you accepted, modified and rejected, and how you verified it, and you must be able to explain every line in a defense.

- **Tool:** Claude (Anthropic), in a chat interface, generated the first full version of this codebase, tests and README from the project brief.
- **Used for:** architecture, all source files, the test suites, documentation.
- **Verification done in the generating session:** the automated suite (44 tests) passes; a headless-Chromium smoke test exercised offline create → reload → sync → coordinator workflow with no page errors. One bug found and fixed along the way: oversized request bodies dropped the connection instead of returning `413`.
- **Accepted / modified / rejected by me:** *(write this yourself after you have read, run and changed the code.)*
