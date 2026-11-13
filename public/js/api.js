// Thin fetch wrapper. Every failure is normalised into an ApiError so the sync
// engine can tell "no network" (retry later) from "server said no" (needs attention).

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'network_error', fields = null, body = null, network = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.body = body;
    this.network = network;
  }
}

export function createApi({ getIdentity, baseUrl = '', isSimulatedOffline = () => false, timeoutMs = 10000, fetchImpl = (...a) => fetch(...a) } = {}) {
  async function request(method, path, body) {
    if (isSimulatedOffline()) throw new ApiError('Offline (simulated).', { network: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const who = getIdentity();
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Role': who.role, 'X-Actor': who.actor },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'Server did not respond in time.' : 'Cannot reach the server.', { network: true });
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body (e.g. a proxy error page) */ }
    if (!res.ok) {
      const e = json?.error;
      throw new ApiError(e?.message || `Server error (${res.status}).`, { status: res.status, code: e?.code || 'http_error', fields: e?.fields || null, body: json });
    }
    return json;
  }
  return {
    listReports: () => request('GET', '/api/reports'),
    createReport: (payload) => request('POST', '/api/reports', payload),
    editReport: (id, body) => request('PATCH', `/api/reports/${encodeURIComponent(id)}`, body),
    changeStatus: (id, body) => request('POST', `/api/reports/${encodeURIComponent(id)}/status`, body),
    history: (id) => request('GET', `/api/reports/${encodeURIComponent(id)}/history`),
  };
}
