// Domain rules shared by the server and the browser client.
// Keeping them in one module means both sides agree on what is valid.

export const CATEGORIES = [
  'Water point',
  'Equipment damage',
  'Service interruption',
  'Safety concern',
  'Maintenance',
  'Other',
];

export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

export const STATUSES = ['Draft', 'Submitted', 'Assigned', 'In Progress', 'Resolved', 'Rejected'];

export const ROLES = ['worker', 'coordinator'];

// Valid status transitions. Anything not listed here is rejected.
//   Draft       -> Submitted                 (worker submits)
//   Submitted   -> Assigned | Rejected       (coordinator triages)
//   Assigned    -> In Progress | Rejected    (coordinator)
//   In Progress -> Resolved | Assigned       (coordinator; back to Assigned = reassign)
//   Resolved    -> In Progress               (reopen, note required)
//   Rejected    -> Submitted                 (worker fixes and resubmits)
export const TRANSITIONS = {
  Draft: ['Submitted'],
  Submitted: ['Assigned', 'Rejected'],
  Assigned: ['In Progress', 'Rejected'],
  'In Progress': ['Resolved', 'Assigned'],
  Resolved: ['In Progress'],
  Rejected: ['Submitted'],
};

// Transitions a field worker may perform. Everything else is coordinator-only.
const WORKER_TRANSITIONS = new Set(['Draft>Submitted', 'Rejected>Submitted']);

// Transitions that must carry an explanation in the history.
const NOTE_REQUIRED = new Set(['Submitted>Rejected', 'Assigned>Rejected', 'Resolved>In Progress']);

// Statuses in which the report's content may still be edited.
export const EDITABLE_STATUSES = ['Draft', 'Submitted', 'Rejected'];

export function allowedTransitions(from, role = 'coordinator') {
  const next = TRANSITIONS[from] || [];
  if (role === 'coordinator') return next;
  return next.filter((to) => WORKER_TRANSITIONS.has(`${from}>${to}`));
}

export function checkTransition(from, to, role, note) {
  if (!STATUSES.includes(to)) {
    return { ok: false, code: 'invalid_status', message: `Unknown status "${to}".` };
  }
  if (!(TRANSITIONS[from] || []).includes(to)) {
    return {
      ok: false,
      code: 'invalid_transition',
      message: `Cannot move a report from "${from}" to "${to}".`,
      allowed: allowedTransitions(from, role),
    };
  }
  if (role !== 'coordinator' && !WORKER_TRANSITIONS.has(`${from}>${to}`)) {
    return {
      ok: false,
      code: 'forbidden_transition',
      message: `Only a coordinator can move a report from "${from}" to "${to}".`,
      allowed: allowedTransitions(from, role),
    };
  }
  if (NOTE_REQUIRED.has(`${from}>${to}`) && !(note && note.trim())) {
    return { ok: false, code: 'note_required', message: `A note is required for "${from}" -> "${to}".` };
  }
  return { ok: true };
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function cleanText(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
}

// Validate a report payload. Returns { errors, value }. With `partial`, only the
// fields that are present are checked (used for edits).
export function validateReport(input, { partial = false, now = Date.now() } = {}) {
  const errors = {};
  const value = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!src) return { errors: { _: 'Body must be a JSON object.' }, value };

  const has = (k) => src[k] !== undefined && src[k] !== null;
  const need = (k) => !partial || has(k);

  if (!partial || has('id')) {
    if (typeof src.id !== 'string' || !ID_RE.test(src.id)) {
      errors.id = 'id must be 8-64 characters: letters, digits, "-" or "_".';
    } else value.id = src.id;
  }

  if (need('category')) {
    if (!CATEGORIES.includes(src.category)) errors.category = `category must be one of: ${CATEGORIES.join(', ')}.`;
    else value.category = src.category;
  }

  if (need('description')) {
    const d = typeof src.description === 'string' ? src.description.trim() : src.description;
    if (typeof d !== 'string' || d.length < 5 || d.length > 2000) {
      errors.description = 'description must be 5-2000 characters.';
    } else if (CONTROL_CHARS.test(d)) {
      errors.description = 'description contains control characters.';
    } else value.description = d;
  }

  if (need('location')) {
    const l = cleanText(src.location);
    if (typeof l !== 'string' || l.length < 2 || l.length > 200) {
      errors.location = 'location must be 2-200 characters.';
    } else if (CONTROL_CHARS.test(l)) {
      errors.location = 'location contains control characters.';
    } else value.location = l;
  }

  if (need('priority')) {
    if (!PRIORITIES.includes(src.priority)) errors.priority = `priority must be one of: ${PRIORITIES.join(', ')}.`;
    else value.priority = src.priority;
  }

  if (need('status')) {
    if (!STATUSES.includes(src.status)) errors.status = `status must be one of: ${STATUSES.join(', ')}.`;
    else value.status = src.status;
  }

  if (need('reportedAt')) {
    const t = typeof src.reportedAt === 'string' ? Date.parse(src.reportedAt) : NaN;
    if (Number.isNaN(t)) errors.reportedAt = 'reportedAt must be an ISO 8601 date-time.';
    else if (t > now + 5 * 60 * 1000) errors.reportedAt = 'reportedAt cannot be in the future.';
    else value.reportedAt = new Date(t).toISOString();
  }

  return { errors, value };
}

// Normalise text for soft duplicate detection.
export function fingerprint(r) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return [r.category, norm(r.location), norm(r.description)].join('|');
}
