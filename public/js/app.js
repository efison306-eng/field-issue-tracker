import { CATEGORIES, PRIORITIES, EDITABLE_STATUSES, allowedTransitions, checkTransition, validateReport } from '/shared/domain.js';
import { openIndexedDbStore } from './store.js';
import { createApi } from './api.js';
import { SYNC, createLocalReport, createSyncEngine, editUnsyncedReport, logActivity, mergeServerReports, submitDraft } from './core.js';

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el; // text always goes through text nodes: user content is never parsed as HTML
}
const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

// ---------- state ----------
const state = { role: lsGet('role', 'worker'), actor: lsGet('actor', ''), simOffline: lsGet('simOffline', '0') === '1', reachable: null, detailId: null, editing: false };
const SYNC_LABEL = { local: 'Local draft', pending: 'Pending', syncing: 'Syncing…', synced: 'Synchronized', failed: 'Failed' };

let store, api, sync;

// ---------- connection + sync orchestration ----------
function setReachable(ok) {
  state.reachable = ok;
  const online = ok && !state.simOffline;
  const el = $('conn');
  el.textContent = state.simOffline ? 'Offline (simulated)' : online ? 'Online' : 'Offline';
  el.className = 'conn ' + (online ? 'online' : 'offline');
}

async function syncAndRefresh({ manual = false } = {}) {
  const out = await sync.run();
  if (out.offline) setReachable(false);
  try {
    const { reports } = await api.listReports();
    await mergeServerReports(store, reports);
    setReachable(true);
  } catch (e) {
    if (e.network) setReachable(false);
    else toast(`Could not refresh from the server: ${e.message}`, true);
  }
  if (out.synced) toast(`${out.synced} report${out.synced > 1 ? 's' : ''} synchronized.`);
  if (out.failed) toast(`${out.failed} report${out.failed > 1 ? 's' : ''} failed to sync. Open them to see why.`, true);
  if (manual && out.offline) toast('Still offline. Your reports are safe on this device and will sync automatically.');
  await render();
  return out;
}

// ---------- list ----------
async function render() {
  const all = (await store.all()).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
  const f = $('filter').value;
  const shown = all.filter((r) =>
    f === 'all' ? true : f === 'unsynced' ? r.syncState === SYNC.PENDING || r.syncState === SYNC.SYNCING : f === 'failed' ? r.syncState === SYNC.FAILED : r.status === f);
  const list = $('list');
  list.replaceChildren(...shown.map(card));
  $('empty').hidden = shown.length > 0;
  const pending = all.filter((r) => r.syncState === SYNC.PENDING || r.syncState === SYNC.SYNCING).length;
  const failed = all.filter((r) => r.syncState === SYNC.FAILED).length;
  $('pendingCount').hidden = pending + failed === 0;
  $('pendingCount').textContent = String(pending + failed);
  $('summary').textContent = `${all.length} total · ${pending} pending · ${failed} failed`;
  if (state.detailId && $('detailDlg').open && !state.editing) await renderDetail(state.detailId, { skipServerHistory: true });
}

function chips(r) {
  return h('div', { class: 'chips' },
    h('span', { class: `chip prio ${r.priority}` }, r.priority),
    h('span', { class: 'chip' }, r.status),
    h('span', { class: `chip sync-${r.syncState}` }, SYNC_LABEL[r.syncState] || r.syncState),
    h('span', { class: 'time' }, fmt(r.reportedAt)));
}

function card(r) {
  return h('li', {},
    h('button', { class: `card p-${r.priority}`, type: 'button', onclick: () => openDetail(r.id) },
      h('div', { class: 'head' }, h('span', { class: 'cat' }, r.category), h('span', { class: 'loc' }, r.location)),
      h('div', { class: 'desc' }, r.description),
      chips(r)));
}

// ---------- new report ----------
function fillOptions(select, options) { select.replaceChildren(...options.map((o) => h('option', { value: o }, o))); }

function showFormErrors(el, e) {
  const lines = e.fields ? Object.values(e.fields) : [e.message];
  el.textContent = lines.join('\n');
  el.hidden = false;
}

async function saveNew(submit) {
  const fd = new FormData($('form'));
  const form = Object.fromEntries(['category', 'description', 'location', 'priority'].map((k) => [k, fd.get(k)]));
  try {
    await createLocalReport(store, form, { submit });
  } catch (e) {
    return showFormErrors($('formErr'), e);
  }
  $('formDlg').close();
  $('form').reset();
  $('formErr').hidden = true;
  toast(submit ? 'Saved on this device.' : 'Draft saved on this device.');
  await render();
  if (submit) syncAndRefresh();
}

// ---------- detail ----------
async function openDetail(id) {
  state.detailId = id;
  state.editing = false;
  await renderDetail(id);
  if (!$('detailDlg').open) $('detailDlg').showModal();
}

function logList(events) {
  if (!events.length) return h('p', { class: 'hint' }, 'Nothing recorded yet.');
  return h('ol', { class: 'log' }, events.map((e) =>
    h('li', { class: 't-' + e.type }, h('time', {}, fmt(e.at) + (e.actor ? ` · ${e.actor}` : '')), e.message)));
}

async function renderDetail(id, { skipServerHistory = false } = {}) {
  const r = await store.get(id);
  const box = $('detail');
  if (!r) { $('detailDlg').close(); return; }
  const unsynced = r.syncState !== SYNC.SYNCED;
  const kids = [
    h('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
      h('h2', {}, r.category), h('button', { type: 'button', class: 'btn', onclick: () => $('detailDlg').close() }, 'Close')),
    chips(r),
  ];

  if (r.syncState === SYNC.FAILED) {
    kids.push(h('div', { class: 'banner', role: 'alert' }, `Sync failed: ${r.lastError || 'unknown error'}. The report is still saved on this device.`));
  }

  if (state.editing) {
    kids.push(editForm(r));
  } else {
    kids.push(h('p', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;margin:0' }, r.description));
    kids.push(h('dl', { class: 'kv' },
      h('dt', {}, 'Location'), h('dd', {}, r.location),
      h('dt', {}, 'Reported'), h('dd', {}, fmt(r.reportedAt)),
      h('dt', {}, 'Server version'), h('dd', {}, r.version ? String(r.version) : 'not on server yet'),
      r.createdBy ? [h('dt', {}, 'Filed by'), h('dd', {}, r.createdBy)] : null));
    kids.push(actionsBlock(r, unsynced));
  }

  kids.push(h('h3', {}, 'Activity on this device'), logList(r.activity || []));
  const serverBox = h('div', {}, h('p', { class: 'hint' }, unsynced ? 'Server history appears after the report syncs.' : 'Loading server history…'));
  kids.push(h('h3', {}, 'Activity on the server'), serverBox);
  box.replaceChildren(...kids);

  if (!unsynced && !skipServerHistory) {
    try {
      const { history } = await api.history(id);
      if (state.detailId === id) serverBox.replaceChildren(logList(history));
    } catch (e) {
      serverBox.replaceChildren(h('p', { class: 'hint' }, e.network ? 'Offline: server history is unavailable right now.' : `Could not load history: ${e.message}`));
    }
  } else if (!unsynced) {
    serverBox.replaceChildren(h('p', { class: 'hint' }, 'Open the report again to reload server history.'));
  }
}

function actionsBlock(r, unsynced) {
  const wrap = h('div', { style: 'display:grid;gap:8px' });
  const btns = h('div', { class: 'actions' });
  const note = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Note (required for reject and reopen)', 'aria-label': 'Note for status change' });

  if (r.syncState === SYNC.FAILED) btns.append(h('button', { class: 'btn primary', type: 'button', onclick: async () => { await sync.retry(r.id); await syncAndRefresh(); } }, 'Retry sync'));
  if (r.status === 'Draft') btns.append(h('button', { class: 'btn primary', type: 'button', onclick: async () => { await submitDraft(store, r.id); toast('Draft submitted.'); await render(); syncAndRefresh(); } }, 'Submit'));
  if (EDITABLE_STATUSES.includes(r.status)) btns.append(h('button', { class: 'btn', type: 'button', onclick: async () => { state.editing = true; await renderDetail(r.id, { skipServerHistory: true }); } }, 'Edit'));

  const moves = r.status === 'Draft' || unsynced ? [] : allowedTransitions(r.status, state.role);
  for (const to of moves) {
    const label = r.status === 'Resolved' && to === 'In Progress' ? 'Reopen' : r.status === 'Rejected' ? 'Resubmit' : to === 'Rejected' ? 'Reject' : `Mark ${to}`;
    btns.append(h('button', { class: 'btn' + (to === 'Rejected' ? ' danger' : ''), type: 'button', onclick: () => transition(r.id, to, note.value) }, label));
  }
  wrap.append(btns);
  if (moves.length) wrap.append(note);
  if (!moves.length && !unsynced && r.status !== 'Draft') {
    wrap.append(h('p', { class: 'hint' }, state.role === 'worker' ? 'Only a coordinator can change the status of this report. Switch role at the top to simulate one.' : 'No further status changes are possible.'));
  }
  if (unsynced && r.status !== 'Draft') wrap.append(h('p', { class: 'hint' }, 'Status changes become available once this report has synced.'));
  return wrap;
}

async function transition(id, to, note) {
  const r = await store.get(id);
  const check = checkTransition(r.status, to, state.role, note);
  if (!check.ok) return toast(check.message, true);
  try {
    const res = await api.changeStatus(id, { status: to, note: note.trim() || undefined, expectedStatus: r.status });
    Object.assign(r, res.report, { syncState: SYNC.SYNCED });
    logActivity(r, 'status_changed', `You changed the status to "${to}".`);
    await store.put(r);
    toast(`Status is now ${to}.`);
  } catch (e) {
    await handleServerError(e, id, 'Status change');
  }
  await render();
  await renderDetail(id);
}

// Shared handling for server-side rejections of an online action.
async function handleServerError(e, id, what) {
  if (e.network) return toast(`${what} needs a connection. You appear to be offline; nothing was changed.`, true);
  const current = e.body?.error?.current;
  if (current) {
    // Someone else changed it first. Take the server copy so the user sees the truth.
    const r = await store.get(id);
    Object.assign(r, current, { syncState: SYNC.SYNCED });
    logActivity(r, 'error', `${what} refused: ${e.message}`);
    await store.put(r);
  }
  toast(`${what} refused: ${e.message}`, true);
}

function editForm(r) {
  const err = h('p', { class: 'err', role: 'alert', hidden: true });
  const cat = h('select', { name: 'category' }); fillOptions(cat, CATEGORIES); cat.value = r.category;
  const pri = h('select', { name: 'priority' }); fillOptions(pri, PRIORITIES); pri.value = r.priority;
  const desc = h('textarea', { name: 'description', rows: 4, maxlength: 2000 }); desc.value = r.description;
  const loc = h('input', { name: 'location', maxlength: 200 }); loc.value = r.location;
  const form = h('form', { novalidate: true, style: 'display:grid;gap:12px;padding:0' },
    h('label', {}, 'Category', cat), h('label', {}, 'Description', desc), h('label', {}, 'Location', loc), h('label', {}, 'Priority', pri), err,
    r.syncState === SYNC.SYNCED ? h('p', { class: 'hint' }, 'This report is already on the server, so saving needs a connection. If someone changed it meanwhile, you will see their version instead.') : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn', onclick: async () => { state.editing = false; await renderDetail(r.id, { skipServerHistory: true }); } }, 'Cancel'),
      h('button', { type: 'submit', class: 'btn primary' }, 'Save changes')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const changes = { category: cat.value, description: desc.value, location: loc.value, priority: pri.value };
    try {
      if (r.syncState === SYNC.SYNCED) {
        const { errors, value } = validateReport(changes, { partial: true });
        if (Object.keys(errors).length) throw Object.assign(new Error('invalid'), { fields: errors });
        const diff = Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== r[k]));
        if (!Object.keys(diff).length) { state.editing = false; return renderDetail(r.id, { skipServerHistory: true }); }
        const res = await api.editReport(r.id, { baseVersion: r.version, ...diff });
        const cur = await store.get(r.id);
        Object.assign(cur, res.report, { syncState: SYNC.SYNCED });
        logActivity(cur, 'edited', `You edited: ${res.changed.join(', ')}.`);
        await store.put(cur);
      } else {
        await editUnsyncedReport(store, r.id, changes);
      }
      state.editing = false;
      toast('Changes saved.');
      await render();
      await renderDetail(r.id);
      if (r.syncState !== SYNC.SYNCED && r.syncState !== SYNC.LOCAL) syncAndRefresh();
    } catch (e) {
      if (e.fields) return showFormErrors(err, e);
      if (e.status === 409) { state.editing = false; await handleServerError(e, r.id, 'Edit'); await render(); return renderDetail(r.id); }
      if (e.status === 422) return showFormErrors(err, e);
      if (e.network) return showFormErrors(err, new Error('You are offline. Edits to a report that is already on the server need a connection.'));
      showFormErrors(err, e);
    }
  });
  return form;
}

// ---------- wiring ----------
function wire() {
  fillOptions($('form').elements.category, CATEGORIES);
  fillOptions($('form').elements.priority, PRIORITIES);
  $('form').elements.priority.value = 'Medium';
  $('role').value = state.role;
  $('actor').value = state.actor;
  $('simOffline').checked = state.simOffline;

  $('role').addEventListener('change', async () => { state.role = $('role').value; lsSet('role', state.role); if (state.detailId && $('detailDlg').open) await renderDetail(state.detailId, { skipServerHistory: true }); });
  $('actor').addEventListener('change', () => { state.actor = $('actor').value.trim(); lsSet('actor', state.actor); });
  $('simOffline').addEventListener('change', () => {
    state.simOffline = $('simOffline').checked;
    lsSet('simOffline', state.simOffline ? '1' : '0');
    setReachable(state.reachable ?? true);
    if (!state.simOffline) syncAndRefresh();
  });
  $('syncBtn').addEventListener('click', () => syncAndRefresh({ manual: true }));
  $('filter').addEventListener('change', render);
  $('newBtn').addEventListener('click', () => { $('formErr').hidden = true; $('formDlg').showModal(); $('form').elements.description.focus(); });
  $('form').addEventListener('click', (e) => {
    const act = e.target.dataset?.act;
    if (act === 'cancel') $('formDlg').close();
    if (act === 'draft') saveNew(false);
  });
  $('form').addEventListener('submit', (e) => { e.preventDefault(); saveNew(true); });
  $('detailDlg').addEventListener('close', () => { state.detailId = null; state.editing = false; });

  window.addEventListener('online', () => syncAndRefresh());
  window.addEventListener('offline', () => setReachable(false));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncAndRefresh(); });
  setInterval(() => { if (!document.hidden) syncAndRefresh(); }, 20000);
}

async function init() {
  try {
    store = await openIndexedDbStore();
  } catch (e) {
    document.body.prepend(h('p', { class: 'banner', role: 'alert' }, 'This browser cannot store reports offline (IndexedDB unavailable). Do not rely on this app here.'));
    throw e;
  }
  api = createApi({ getIdentity: () => ({ role: state.role, actor: state.actor }), isSimulatedOffline: () => state.simOffline });
  sync = createSyncEngine({ store, api, onChange: () => render() });
  wire();
  setReachable(navigator.onLine);
  await sync.recoverInterrupted();
  await render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  syncAndRefresh();
}
init();
