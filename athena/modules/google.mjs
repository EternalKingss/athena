// modules/google.mjs -- Module 3, phase 2: Gmail + Calendar.
//
// One OAuth app, one refresh token, two Google APIs -- see docs/MODULE3_PLAN.md Section 2
// for why these two share a module (one auth surface, not independently-owned integrations).
//
// The rule that matters most here (plan Section 1): read is unrestricted, a calendar event
// is auto-actionable (reversible -- delete undoes it), and anything that reaches another
// person -- an email -- is draft-only. That last one isn't just a prompt instruction: the
// OAuth consent this module was minted with only ever requested gmail.readonly and
// gmail.compose, never gmail.send. There is no access token this module can hold that Gmail
// will accept for actually sending mail, so "draft, never send" is enforced by Google's own
// permission system, one layer below anything this file's code could get wrong.
//
// Isolation, by construction: this file imports nothing from modules/system.mjs,
// modules/browser.mjs, or tools.mjs, and nothing outside kernel/index.mjs imports this file.

import { makeCapability } from '../kernel/contract.mjs';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } from '../config.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

// ---- Access token cache -----------------------------------------------------------------
// One refresh token mints short-lived (~1h) access tokens on demand. Cached in memory only
// -- never written to disk, unlike the refresh token itself (config/.env, same convention
// as every other credential this project stores).
const _token = { accessToken: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_token.accessToken && _token.expiresAt > now + 30_000) return _token.accessToken;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google credentials not configured -- set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in config/.env (run google_oauth_setup.mjs once to mint the refresh token)');
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: GOOGLE_REFRESH_TOKEN,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // invalid_grant here almost always means the 7-day testing-mode refresh token expired
    // (see docs/MODULE3_PLAN.md) -- surface that plainly instead of a bare HTTP code.
    const hint = data.error === 'invalid_grant'
      ? ' -- refresh token likely expired (7-day limit while this app is in Google\'s Testing status); re-run google_oauth_setup.mjs'
      : '';
    throw new Error(`Google token refresh failed: ${resp.status} ${JSON.stringify(data)}${hint}`);
  }
  _token.accessToken = data.access_token;
  _token.expiresAt = now + (data.expires_in || 3000) * 1000;
  return _token.accessToken;
}

async function googleFetch(url, opts = {}) {
  const token = await getAccessToken();
  const resp = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  const text = await resp.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(`Google API error ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

function b64urlDecode(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerMap(headers) {
  return Object.fromEntries((headers || []).map(h => [h.name, h.value]));
}

// Walks a Gmail message payload for the best human-readable body: plain text if present,
// otherwise HTML, recursing into multipart/* nesting (alternative inside mixed, etc.).
function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data && !payload.parts) return b64urlDecode(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
    if (plain) return b64urlDecode(plain.body.data);
    const html = payload.parts.find(p => p.mimeType === 'text/html' && p.body?.data);
    if (html) return b64urlDecode(html.body.data);
    for (const p of payload.parts) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return '';
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
function toCalendarTime(value, timeZone) {
  if (typeof value !== 'string' || !value) return null;
  return DATE_ONLY.test(value) ? { date: value } : { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

// ---- Capability handlers -----------------------------------------------------------------

async function handleEmailList(args) {
  const max = Math.min(Math.max(Number(args.maxResults) || 10, 1), 50);
  const params = new URLSearchParams({ maxResults: String(max) });
  if (args.query) params.set('q', args.query);

  const list = await googleFetch(`${GMAIL_BASE}/messages?${params}`);
  const ids = (list.messages || []).map(m => m.id);
  const messages = await Promise.all(ids.map(async (id) => {
    const msg = await googleFetch(`${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    const h = headerMap(msg.payload?.headers);
    return { id: msg.id, threadId: msg.threadId, subject: h.Subject || '(no subject)', from: h.From || '', date: h.Date || '', snippet: msg.snippet || '' };
  }));
  return { ok: true, count: messages.length, resultSizeEstimate: list.resultSizeEstimate ?? messages.length, messages };
}

async function handleEmailRead(args) {
  if (!args.messageId) return { ok: false, failureReason: 'email_read needs messageId (from email_list)' };
  const msg = await googleFetch(`${GMAIL_BASE}/messages/${args.messageId}?format=full`);
  const h = headerMap(msg.payload?.headers);
  return {
    ok: true,
    id: msg.id,
    threadId: msg.threadId,
    subject: h.Subject || '(no subject)',
    from: h.From || '',
    to: h.To || '',
    date: h.Date || '',
    body: extractBody(msg.payload),
  };
}

async function handleEmailDraft(args) {
  if (!args.to) return { ok: false, failureReason: 'email_draft needs to' };
  if (!args.subject) return { ok: false, failureReason: 'email_draft needs subject' };
  if (!args.body) return { ok: false, failureReason: 'email_draft needs body' };

  const lines = [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
  ];
  if (args.inReplyTo) { lines.push(`In-Reply-To: ${args.inReplyTo}`); lines.push(`References: ${args.inReplyTo}`); }
  lines.push('Content-Type: text/plain; charset="UTF-8"', '', args.body);
  const raw = b64urlEncode(lines.join('\r\n'));

  const payload = { message: { raw, ...(args.threadId ? { threadId: args.threadId } : {}) } };
  const resp = await googleFetch(`${GMAIL_BASE}/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: true, draftId: resp.id, note: 'Draft created in Gmail -- NOT sent. This module has no ability to send (no gmail.send scope was ever granted); review and send it yourself.' };
}

async function handleCalendarList(args) {
  const calId = encodeURIComponent(args.calendarId || 'primary');
  const timeMin = args.timeMin || new Date().toISOString();
  const timeMax = args.timeMax || new Date(Date.now() + (Number(args.daysAhead) || 7) * 86_400_000).toISOString();
  const params = new URLSearchParams({
    timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime',
    maxResults: String(Math.min(Math.max(Number(args.maxResults) || 20, 1), 100)),
  });
  const resp = await googleFetch(`${CAL_BASE}/${calId}/events?${params}`);
  const events = (resp.items || []).map(e => ({
    id: e.id,
    summary: e.summary || '(no title)',
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || '',
    attendees: (e.attendees || []).map(a => a.email),
  }));
  return { ok: true, calendarId: args.calendarId || 'primary', count: events.length, events };
}

async function handleCalendarCreateEvent(args) {
  if (!args.summary) return { ok: false, failureReason: 'calendar_create_event needs summary' };
  if (!args.start) return { ok: false, failureReason: 'calendar_create_event needs start (ISO datetime or YYYY-MM-DD for all-day)' };
  if (!args.end) return { ok: false, failureReason: 'calendar_create_event needs end (ISO datetime or YYYY-MM-DD for all-day)' };

  const calId = encodeURIComponent(args.calendarId || 'primary');
  const body = {
    summary: args.summary,
    description: args.description || undefined,
    location: args.location || undefined,
    start: toCalendarTime(args.start, args.timeZone),
    end: toCalendarTime(args.end, args.timeZone),
    attendees: Array.isArray(args.attendees) ? args.attendees.map(email => ({ email })) : undefined,
  };
  const resp = await googleFetch(`${CAL_BASE}/${calId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: true, eventId: resp.id, htmlLink: resp.htmlLink, summary: resp.summary };
}

async function handleCalendarUpdateEvent(args) {
  if (!args.eventId) return { ok: false, failureReason: 'calendar_update_event needs eventId (from calendar_list)' };
  const calId = encodeURIComponent(args.calendarId || 'primary');
  const patch = {};
  if (args.summary !== undefined) patch.summary = args.summary;
  if (args.description !== undefined) patch.description = args.description;
  if (args.location !== undefined) patch.location = args.location;
  if (args.start !== undefined) patch.start = toCalendarTime(args.start, args.timeZone);
  if (args.end !== undefined) patch.end = toCalendarTime(args.end, args.timeZone);
  if (args.attendees !== undefined) patch.attendees = (args.attendees || []).map(email => ({ email }));
  if (Object.keys(patch).length === 0) return { ok: false, failureReason: 'calendar_update_event needs at least one field to change (summary, description, location, start, end, attendees)' };

  const resp = await googleFetch(`${CAL_BASE}/${calId}/events/${encodeURIComponent(args.eventId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return { ok: true, eventId: resp.id, htmlLink: resp.htmlLink, updated: Object.keys(patch) };
}

// ---- Capability declarations --------------------------------------------------------------
// Draft/write actions are localOk: false -- a small local model fabricating tool results was
// the exact bug this whole project just spent a session fixing (see selfcheck.mjs / the
// hasWord regression); Gmail/Calendar writes touch real accounts and real other people's
// inboxes, so they stay cloud-model-only until local-model reliability earns that trust.
// Reads are lower-stakes and left at the localOk default (true).
const CAP_DEFS = [
  {
    name: 'email_list',
    description: 'List recent Gmail messages (subject, sender, date, snippet). Optionally filter with query, using Gmail search syntax (e.g. "is:unread", "from:someone@example.com", "subject:invoice").',
    authoritative: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query. Omit to list the most recent messages.' },
        maxResults: { type: 'number', description: 'Max messages to return (1-50, default 10).' },
      },
    },
  },
  {
    name: 'email_read',
    description: 'Read the full content (subject, sender, date, body) of one Gmail message by id.',
    authoritative: true,
    parameters: {
      type: 'object',
      properties: { messageId: { type: 'string', description: 'Message id, from email_list.' } },
      required: ['messageId'],
    },
  },
  {
    name: 'email_draft',
    description: 'Create a Gmail DRAFT -- never sends. This account\'s Google authorization has no send permission at all, so there is no way for this tool to actually send mail; the draft sits in Gmail until the user reviews and sends it themselves.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string', description: 'Plain-text body.' },
        threadId: { type: 'string', description: 'Optional -- attach this draft to an existing Gmail thread (e.g. to draft a reply).' },
        inReplyTo: { type: 'string', description: 'Optional -- the Message-ID header of the message being replied to, for proper email threading.' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'calendar_list',
    description: 'List upcoming events on a Google Calendar (default: primary calendar, next 7 days).',
    authoritative: true,
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Defaults to "primary". Use an id from a known calendar (e.g. a shared/family calendar) to check a different one.' },
        daysAhead: { type: 'number', description: 'How many days ahead to look (default 7). Ignored if timeMin/timeMax are given.' },
        timeMin: { type: 'string', description: 'Optional ISO datetime lower bound.' },
        timeMax: { type: 'string', description: 'Optional ISO datetime upper bound.' },
        maxResults: { type: 'number', description: 'Default 20, max 100.' },
      },
    },
  },
  {
    name: 'calendar_create_event',
    description: 'Create a new event on a Google Calendar (default: primary). Reversible -- calendar_update_event or deleting it from Google Calendar undoes it.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'Start time -- an ISO datetime (e.g. 2026-09-15T14:00:00-06:00), or a bare YYYY-MM-DD for an all-day event.' },
        end: { type: 'string', description: 'End time, same format as start.' },
        timeZone: { type: 'string', description: 'IANA timezone (e.g. America/Edmonton) if start/end datetimes have no explicit UTC offset.' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses.' },
        calendarId: { type: 'string', description: 'Defaults to "primary".' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'calendar_update_event',
    description: 'Update fields on an existing calendar event (found via calendar_list). Only pass the fields that should change.',
    localOk: false,
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'Event id, from calendar_list.' },
        calendarId: { type: 'string', description: 'Defaults to "primary".' },
        summary: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        timeZone: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        attendees: { type: 'array', items: { type: 'string' } },
      },
      required: ['eventId'],
    },
  },
];

export const googleModule = {
  name: 'google',

  capabilities: CAP_DEFS.map(makeCapability),

  // Structural readiness only (credentials configured), not a live API ping -- same
  // philosophy as browserModule.healthCheck() checking the relay, not the extension.
  healthCheck() {
    return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN);
  },

  async execute(capability, args = {}) {
    switch (capability) {
      case 'email_list': return JSON.stringify(await handleEmailList(args));
      case 'email_read': return JSON.stringify(await handleEmailRead(args));
      case 'email_draft': return JSON.stringify(await handleEmailDraft(args));
      case 'calendar_list': return JSON.stringify(await handleCalendarList(args));
      case 'calendar_create_event': return JSON.stringify(await handleCalendarCreateEvent(args));
      case 'calendar_update_event': return JSON.stringify(await handleCalendarUpdateEvent(args));
      default: return JSON.stringify({ ok: false, failureReason: 'unknown google capability: ' + capability });
    }
  },
};
