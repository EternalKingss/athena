# Module 3 â€” Plan

**Status:** phase 1 (read_applicant_profile), phase 2 (modules/google.mjs), and phase 3's submit-click safeguard are built and verified live. Phase 3 itself needs no new module (see Section 2), so it is usable now via agent_loop.mjs / a normal chat task. Phases 4-5 (fill_pdf_form, modules/flights.mjs) are still planning.
**Scope, as given:** job search + apply (resume-aware), continuous email monitoring with
calendar sync, internal-job-posting auto-draft, document download/fill/draft, flight
search/compare/book. Plus whatever isn't listed yet.

This doc exists because "module 3" turned out to name five distinct integrations, not one
module. Trying to force all of it into a single `modules/module3.mjs` would repeat the exact
mistake `delegate.mjs` just got fixed for â€” a name that doesn't match what the thing actually
is. What follows is the honest shape: which pieces are genuinely new capability domains
(new modules, isolated the same way browser is), which are core-OS tools (like
`delegate_to_local` ended up), and which are just new *behavior* built by composing what
already exists.

---

## 1. The one rule everything else follows

You said it yourself for email â€” draft, never send â€” and it generalizes to every capability
here, because the underlying shape is identical: an action that, once taken, reaches outside
Athena and can't be quietly undone.

| Action | Treatment |
|---|---|
| Read email, read calendar, read a job posting, search flights | Unrestricted. Reading is free. |
| Add a calendar event | Auto-actionable. Reversible with one click (delete event), same spirit as the existing tier-0/1 tools. |
| Draft a reply, fill a document | Auto-actionable, but the *output* is a draft/local file -- never sent or finalized. |
| Submit a job application through a web form (Indeed, a company ATS, a career page) | **Auto-actionable, no approval** -- revised 2026-09-10 on direct instruction. Skips any employer that matches your current or past work history (see below). |
| Apply to a job found some other way (e.g. via a Google search that turns up a posting with no online form, just a contact to email) | Auto-actionable up to a draft. The email itself is never sent, the same way any other email draft isn't -- not a special case for job applications, just the one existing rule below. |
| Complete a purchase or booking (checkout, pay, place an order, book a flight) | Requires your explicit go-ahead, every time, with the actual details shown -- no `AUTO_APPROVE` bypass, ever. |

The important design decision: rather than "build the send/submit tool, then remember to gate
it," the send/submit action should **not exist as a callable capability at all** wherever
that's possible. Concretely:

- The Gmail OAuth app requests `gmail.readonly` + `gmail.compose` scopes only â€” never
  `gmail.send`. Not "Athena is told not to send email," but "Athena is not capable of sending
  email," enforced by Google's own permission system, one layer below anything Athena's code
  could get wrong.
- There is still no `job_application_submit` tool -- same reasoning as email: the action
  should not exist as its own callable capability. But unlike email, the fill-it-out flow's
  own `browser_click` on the page's real submit button IS allowed to fire on its own now
  (revised 2026-09-10, direct instruction: job applications don't need your go-ahead, only
  purchases and bookings do). See `tools.mjs`'s `PURCHASE_LIKE`/`JOB_APPLY_LIKE` for exactly
  what stays gated (money-moving clicks) versus what doesn't (everything else, including an
  application submit).
- Before submitting anywhere, cross-reference the employer's name against your work history
  in `read_applicant_profile`'s extracted data (current job, and anything listed as past
  work) and skip it -- never apply to a company you already work for or have worked for. This
  is instruction-level (part of how a job-search task gets phrased), not a code gate -- there's
  no reliable way to classify "is this the same employer" from a click's selector/text alone,
  the way PURCHASE_LIKE can classify "is this a checkout button."
- Flight booking is the one case that can't stop at "no tool exists," because getting a seat
  held sometimes requires actually walking through the booking flow. That step is `tier 2`,
  same mechanism `tools.mjs` already uses for irreversible shell commands â€” approval required
  unconditionally, with the itinerary and traveler details shown in full before you approve.

This is the same principle already live in `tools.mjs`'s `IRREVERSIBLE` list (format a disk,
delete a registry key, reboot mid-work) â€” module 3 just has its own version of "can this be
undone," applied to network-facing actions instead of local ones.

---

## 2. Shape of the work

Five things were asked for. They land in four different places:

### New modules (genuinely separate capability domains, isolated like `browser.mjs`)

**`modules/google.mjs`** â€” Gmail + Calendar, one module because they share one OAuth app and
one refresh token; splitting them would just duplicate the auth plumbing for no isolation
benefit (they're not independently-owned integrations the way browser and flights are).
Capabilities: `email_list` / `email_read` (readonly), `email_draft` (compose scope, never
send), `calendar_list` / `calendar_create_event` / `calendar_update_event`.

**`modules/flights.mjs`** â€” flight search/compare via a flights API (Amadeus Self-Service â€”
free-tier, self-serve signup, no partner-approval wait like Skyscanner's API requires).
Capabilities: `flight_search` (readonly, returns multiple options with prices),
`flight_book` (tier 2 â€” the one real "commits money" step in this whole plan).

### Core-OS tools (added to `tools.mjs`, same reasoning that moved `delegate_to_local` there)

These aren't capability domains â€” they're small, local, single-purpose helpers, not something
with its own protocol/relay/auth surface:

- **`read_applicant_profile`** â€” reads your resume once, caches structured fields (name,
  contact, work history, education, skills) to a local JSON file next to the resume, so job
  applications and document fills don't re-parse the raw file every time. Re-parses
  automatically when the source file's mtime changes.
- **`fill_pdf_form`** â€” takes a downloaded fillable PDF (AcroForm fields) plus data (from the
  applicant profile, or given directly), fills it, saves a new copy alongside the original,
  never overwrites the source. Uses `pdf-lib` (pure JS, no native deps, fits the "she carries
  what she needs on her own drive" rule already governing dependency choices in this project).

### New behavior (composes what already exists â€” no new module, no new file even)

**Job search & apply.** This is `agent_loop.mjs`'s existing bounded/verified/risk-gated loop,
given a task like "search Indeed for CCP-track EMS jobs in Edmonton, read the top 5, and draft
applications for ones that match this profile" â€” using module 2's existing browser
primitives (`browser_navigate`, `browser_read_text`, `browser_click`, `browser_type`) plus the
new `read_applicant_profile` tool for the data. Nothing architecturally new here; it's the
same delegation machinery pointed at a bigger, better-specified task. The only new piece is
the tier-2 gate at the actual submit button (see Â§1).

**Internal job posting â†’ auto-draft.** A trigger, not a tool: when `modules/google.mjs`'s
email monitor sees a message matching "internal job posting" (subject/sender heuristics,
same shape as `task_router.mjs`'s `looksBasic()` classifier), it kicks off the job-apply flow
above in draft-only mode and notifies you it's ready for review. Lives in whatever process
already polls email (see Â§4) â€” not a new capability, a new trigger source, same relationship
`daemon.mjs`'s scheduled tasks already have to the kernel.

**"Anything need a calendar entry?"** Same shape â€” the email monitor reads new messages,
and for ones that look like they contain a date/time commitment, calls `calendar_create_event`
directly (auto-actionable per Â§1, not gated).

---

## 3. What has to exist before any of this can run

- **A Google Cloud project with Gmail API + Calendar API enabled**, an OAuth client
  (Desktop app type â€” right fit for a locally-run tool, not a web app), and a one-time consent
  flow run once to mint a refresh token. That token gets stored the same way `ANTHROPIC_API_KEY`
  etc. already live in `config/.env` â€” not committed, not logged.
- **An Amadeus Self-Service API account** (free tier) for flight search/pricing â€” API key +
  secret, same storage treatment.
- **Your resume's actual file path**, so `read_applicant_profile` has something to read. I
  don't have this yet â€” need it before phase 1 below can do anything real.
- **`pdf-lib`** as a new npm dependency for `fill_pdf_form` (the only new dependency this
  whole plan needs â€” everything else reuses existing infrastructure).

None of the above needs deciding today beyond the resume path â€” they're setup checklist items
for whenever a given phase actually starts.

---

## 4. One open design question

Email monitoring needs *something* polling Gmail on a schedule (or via push notifications,
which Gmail's API supports but requires a public webhook endpoint â€” not a natural fit for a
machine that isn't always reachable from the internet). The straightforward option is
`kernel/daemon.mjs`'s existing scheduled-task mechanism, polling on an interval (a few
minutes), the same way it already runs other periodic checks. That's the default assumption
in this plan unless there's a reason to want push-based delivery instead.

---

## 5. Suggested build order

1. **`read_applicant_profile`** â€” small, self-contained, unblocks phases 3 and 4, and is
   useful on its own the moment your resume path is in hand.
2. **`modules/google.mjs`** â€” unlocks the most-requested behavior (continuous email
   awareness + calendar sync) in one integration, and its email-monitor becomes the trigger
   source for the internal-job-posting flow later.
3. **Job search & apply** â€” needs 1 (profile data) and reuses module 2 (already built);
   wire the internal-job-posting trigger from 2 into it once both exist.
4. **`fill_pdf_form`** â€” needs 1 (profile data) and 2 (pulling attachments out of email).
5. **`modules/flights.mjs`** â€” fully independent of the rest; do it whenever, in any order
   relative to 1-4.

Phase 1 is done: read_applicant_profile (tools.mjs) was already fully implemented --
PDF extraction via pdf-parse, mtime-keyed cache at data/memory/applicant_profile.json,
registered for local models too. It only needed RESUME_PATH pointed at the real file --
set in config/.env to C:\Users\force\OneDrive\Desktop\Resume\Main Resume.pdf and
verified live: Athena calls the tool, extracts the real resume text, and produces an
accurate (non-fabricated) summary of it. Phase 2 (modules/google.mjs) is next, and
needs the Google Cloud OAuth setup from Section 3 before it can do anything real.


## Phase 3 status (job search & apply) -- auto-submit built and verified live, revised 2026-09-10

Per Section 2, this phase needed no new module and no new file -- just `agent_loop.mjs`
(or a normal chat task) pointed at module 2's existing browser primitives plus
`read_applicant_profile`. The one piece of new code is the risk classification a
`browser_click` gets in `tools.mjs`, and it went through two versions:

**v1 (built first):** every submit/apply/purchase-like click was tier 2 (approval required).
Verified live: asked Athena to fill and click "Submit order" on a public test form
(https://httpbin.org/forms/post, chosen so a real submit would be harmless) -- it paused
with an `approval_required` + yes/no `clarify` prompt and never dispatched the click until
answered.

**v2 (current, revised same day on direct instruction):** job-application submission
doesn't need approval at all -- only purchases/bookings do. `SUBMIT_LIKE` was split into:

- `PURCHASE_LIKE` (place order, buy now, pay now, book now, confirm/complete
  order-purchase-payment-booking, checkout, finalize order/booking) -- still tier 2 in
  `classifyRisk`, still flagged by `irreversibleReason` so the gate holds even under
  `AUTO_APPROVE` (only `AUTO_APPROVE_ALL`, not set on this machine, would remove it).
- `JOB_APPLY_LIKE` (submit application, apply now, apply for this job, easy apply, send
  application, finalize application) -- named only so `tool_start`/approval logs read
  clearly; matching it does not change the tier. It, and anything else that doesn't match
  `PURCHASE_LIKE`, is tier 1 -- fires immediately, no approval, no different from any other
  ordinary click.

This is a text-match heuristic on the clicked element's `selector`/`text`, not a true
understanding of the page, so it can be wrong in either direction -- a bare "Submit" with no
other cue is genuinely ambiguous (it could be a job form or a checkout). `PURCHASE_LIKE` is
checked first and wins on any overlap, so the failure mode that's biased against is a real
payment going through unapproved, not a job application needing a second look.

Email-based applications are unaffected by any of this -- `modules/google.mjs`'s OAuth app
was never granted `gmail.send`, so a drafted application email cannot be sent by Athena
regardless of tier. That boundary is Google's permission system, not this classifier.

Verified:
- `selfcheck.mjs`: 6 `browser_click` unit tests -- job-apply text (`Submit Application`,
  `Apply Now`) is tier 1 and not irreversible; purchase text (`Place Order`, `Buy Now`,
  `Complete Purchase`) is tier 2 and irreversible; ordinary text (`Next page`) is tier 1 and
  not irreversible. 49/49 passing overall.
- Live, end-to-end, in the real running UI (from the v1 test, still valid since only the
  classification changed, not the mechanism): a tier-1 `browser_click` dispatches immediately
  with no approval event at all -- confirmed for the ordinary field click in that same run.
  A tier-2 click is what produces `approval_required`; job-apply clicks no longer reach that
  branch.

Still open, not a build item: the employer-exclusion rule above is instruction-level, so it
only takes effect if a job-search task actually says to check `read_applicant_profile`'s
work history before applying -- worth stating explicitly whenever you kick one off, at least
until/unless it's worth baking into a fixed task template. And it still hasn't been run
against a real job board for a real search-and-apply -- only the safeguard itself has been
live-tested, against a disposable form.

### 2026-09-10 addendum -- live-tested against real Indeed, blocked on browser reliability, not on the classifier

Ran this for real: searched Indeed for EMR/EMS/security roles matching the resume on file and found
genuinely strong, in-scope matches (an Emergency Medical Responder posting at Alexander Safety --
EMR/H2S Alive/Class 5 all satisfied, employer not on the exclusion list -- plus several paramedic and
security postings). Got as far as the real "Apply with Indeed" flow, resume auto-attached correctly.
No application was submitted today. Two separate, unrelated things blocked it, and neither is a bug in
the `PURCHASE_LIKE`/`JOB_APPLY_LIKE` classifier itself:

1. Athena's own turn loop still silently hangs on this class of task (long, multi-step, real browsing)
   -- reproduced across three separate live attempts before this addendum, no error logged, no tool
   call ever fired. Root cause not yet found (see the live-diagnostic notes from this session -- a
   genuine long-held HTTPS connection with no output is the current best lead).
2. Separately, driving the browser directly (bypassing Athena entirely) surfaced a second, unrelated
   problem: on this machine, Chrome's own Google-account sign-in/picker (FedCM) reliably crashes the
   whole Chrome process the instant it's invoked -- reproduced 3 times. That's an environment/Chrome
   issue, not Athena code, but it means "just drive the browser instead" isn't a clean workaround
   either until it's fixed.

Decision: leave the auto-apply classification code in `tools.mjs` exactly as it is -- it's correct and
still 49/49 on `selfcheck.mjs` -- but stop re-running live job-search-and-apply attempts through
Athena's own loop until one of the two blockers above is actually resolved. This is a known, named
limit of the current build, not something to keep forcing retries against.

## Phase 2 status (modules/google.mjs) -- done, verified live

Built as its own module (kernel/index.mjs registers it alongside system/browser), not bolted
onto tools.mjs -- matches the plan's own reasoning for why Gmail+Calendar get one module.

Capabilities: email_list, email_read (both read, localOk:true), email_draft (compose only --
localOk:false), calendar_list (read, localOk:true), calendar_create_event, calendar_update_event
(both localOk:false). Write capabilities are cloud-model-only on purpose -- see the module's
own comment on why local models don't get them yet.

OAuth: one Google Cloud project (athena-508123), Gmail API + Calendar API enabled, Desktop
OAuth client, forcepack6@gmail.com added as a test user. Refresh token minted via
google_oauth_setup.mjs (repo root) and stored in config/.env as GOOGLE_CLIENT_ID /
GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.

Known limitation, not yet resolved: this app is in Google's "Testing" publishing status
(not verified), so the refresh token expires after 7 days -- confirmed by the token
response's own refresh_token_expires_in: 604799. Re-running google_oauth_setup.mjs re-mints
it. Getting Google to lift that means restricted-scope verification (a paid third-party
security assessment for Gmail scopes) -- not pursued; revisit only if the weekly re-auth
becomes annoying enough to be worth it.

Verified live (2026-09-10): email_list and calendar_list returned real inbox/calendar data
through a running Athena instance (claude-sonnet-5); email_draft and calendar_create_event
each created a real Gmail draft and Calendar event, independently confirmed via direct
Gmail/Calendar API calls (not just the tool's own self-report), then deleted as test cleanup.
selfcheck.mjs: 43/43 passing (was 39; +4 for the new module's capability-count and
localOk-gating assertions).