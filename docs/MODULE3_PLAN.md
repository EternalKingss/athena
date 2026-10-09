# Module 3 -- Plan

**Status:** phase 1 (Gmail + Calendar, `modules/google.mjs`) is built and verified live.
Phases 2-3 (`fill_pdf_form`, `modules/flights.mjs`) are still planning.
**Scope:** continuous email monitoring with calendar sync, document download/fill/draft, and
flight search/compare/book.

Job search, job applications and resume reading were removed in v3.2 -- not paused, removed:
the `read_applicant_profile` tool, the job-apply click classification, the `RESUME_PATH`
setting and the `pdf-parse` dependency are all gone. Nothing in Module 3 depends on them.

---

## 1. The one rule everything else follows

Draft, never send -- and it generalizes to every capability here, because the underlying
shape is identical: an action that, once taken, reaches outside Athena and can't be quietly
undone.

| Action | Treatment |
|---|---|
| Read email, read calendar, search flights | Unrestricted. Reading is free. |
| Add a calendar event | Auto-actionable. Reversible with one click (delete event), same spirit as the existing tier-0/1 tools. |
| Draft a reply, fill a document | Auto-actionable, but the *output* is a draft/local file -- never sent or finalized. |
| Book a flight, buy anything | **Tier 2** -- approval required, with full details shown before you approve. |

The send/submit action should **not exist as a callable capability at all** wherever that's
possible:

- The Gmail OAuth app requests `gmail.readonly` + `gmail.compose` scopes only -- never
  `gmail.send`. Not "Athena is told not to send email," but "Athena is not capable of sending
  email," enforced by Google's own permission system, one layer below anything Athena's code
  could get wrong.
- Flight booking is the one case that can't stop at "no tool exists," because getting a seat
  held sometimes requires walking through the booking flow in the browser. There is no
  `flight_book` tool; the gate is `tools.mjs`'s `PURCHASE_LIKE` check on `browser_click`
  (place order, buy now, book now, checkout, ...), which is tier 2 and flagged by
  `irreversibleReason`, so it holds even under `AUTO_APPROVE`.

---

## 2. Shape of the work

**`modules/google.mjs`** -- Gmail + Calendar, one module because they share one OAuth app and
one refresh token. Capabilities: `email_list` / `email_read` (readonly), `email_draft`
(compose scope, never send), `calendar_list` / `calendar_create_event` /
`calendar_update_event`.

**`fill_pdf_form`** (core tool in `tools.mjs`) -- takes a downloaded fillable PDF (AcroForm
fields) plus the data to put in it, fills it, saves a new copy alongside the original, never
overwrites the source. Would use `pdf-lib` (pure JS, no native deps).

**`modules/flights.mjs`** -- flight search/compare via a flights API (Amadeus Self-Service --
free tier, self-serve signup). Capability: `flight_search` (readonly, returns multiple options
with prices). Booking goes through the browser and the tier-2 gate above.

**"Anything need a calendar entry?"** -- new behavior, not a tool: the email monitor reads new
messages, and for ones that look like they contain a date/time commitment, calls
`calendar_create_event` directly (auto-actionable per Section 1).

---

## 3. What has to exist before each phase can run

- **Phase 1:** a Google Cloud project with Gmail API + Calendar API enabled, a Desktop OAuth
  client, and a refresh token in `config/.env`. Done.
- **Phase 2:** `pdf-lib` as an npm dependency.
- **Phase 3:** an Amadeus Self-Service API account (key + secret in `config/.env`).

---

## 4. One open design question

Email monitoring needs *something* polling Gmail on a schedule (or push notifications, which
need a public webhook endpoint -- not a natural fit for a machine that isn't always reachable
from the internet). The default assumption is `kernel/daemon.mjs`'s scheduled-task mechanism,
polling every few minutes.

---

## 5. Build order

1. **`modules/google.mjs`** -- done.
2. **`fill_pdf_form`** -- needs 1 for pulling attachments out of email.
3. **`modules/flights.mjs`** -- fully independent; any time.

---

## Phase 1 status (modules/google.mjs) -- done, verified live

Built as its own module (kernel/index.mjs registers it alongside system/browser), not bolted
onto tools.mjs.

Capabilities: email_list, email_read (both read, localOk:true), email_draft (compose only --
localOk:false), calendar_list (read, localOk:true), calendar_create_event, calendar_update_event
(both localOk:false). Write capabilities are cloud-model-only on purpose -- see the module's
own comment on why local models don't get them yet.

OAuth: one Google Cloud project, Gmail API + Calendar API enabled, Desktop OAuth client, the
owner's account added as a test user. Refresh token minted via google_oauth_setup.mjs (repo
root) and stored in config/.env as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET /
GOOGLE_REFRESH_TOKEN.

Known limitation, not yet resolved: this app is in Google's "Testing" publishing status
(not verified), so the refresh token expires after 7 days (refresh_token_expires_in: 604799).
Re-running google_oauth_setup.mjs re-mints it. Getting Google to lift that means
restricted-scope verification (a paid third-party security assessment for Gmail scopes) --
not pursued; revisit only if the weekly re-auth becomes annoying enough to be worth it.

Verified live (2026-09-10): email_list and calendar_list returned real inbox/calendar data
through a running Athena instance; email_draft and calendar_create_event each created a real
Gmail draft and Calendar event, independently confirmed via direct Gmail/Calendar API calls,
then deleted as test cleanup.
