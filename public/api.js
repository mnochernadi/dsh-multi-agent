/** Thin REST + SSE client for the dashboard API. */

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : `${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const api = {
  health: () => request('GET', '/api/health'),
  info: () => request('GET', '/api/info'),
  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (settings) => request('PUT', '/api/settings', settings),
  getProviders: () => request('GET', '/api/providers'),
  importProviders: () => request('POST', '/api/providers/import', {}),
  putProvider: (name, spec) => request('PUT', '/api/providers', { name, spec }),
  removeProvider: (name) => request('DELETE', `/api/providers/${encodeURIComponent(name)}`),
  validate: (payload) => request('POST', '/api/validate', payload),
  listEngines: () => request('GET', '/api/engines'),
  saveEngine: (engine) => request('PUT', '/api/engines', { engine }),
  removeEngine: (id) => request('DELETE', `/api/engines/${encodeURIComponent(id)}`),
  restoreEngine: (id) => request('POST', `/api/engines/${encodeURIComponent(id)}/restore`, {}),
  detectEngine: (id) => request('POST', `/api/engines/${encodeURIComponent(id)}/detect`, {}),
  testEngine: (id) => request('POST', `/api/engines/${encodeURIComponent(id)}/test`, {}),
  handoffEngine: (id, cwd) => request('POST', `/api/engines/${encodeURIComponent(id)}/handoff`, { cwd }),
  listRuns: () => request('GET', '/api/runs'),
  getRun: (id, sinceSeq = 0) => request('GET', `/api/runs/${encodeURIComponent(id)}?sinceSeq=${sinceSeq}`),
  startRun: (payload) => request('POST', '/api/runs', payload),
  abortRun: (id) => request('POST', `/api/runs/${encodeURIComponent(id)}/abort`, {}),
};

/**
 * Subscribe to the dashboard event stream.
 *
 * The browser's own EventSource reconnects and replays `Last-Event-ID`, so a
 * long run survives a dropped connection without losing progress.
 */
export function openEventStream(handlers) {
  let source = null;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    source = new EventSource('/api/events');

    source.addEventListener('ready', () => {
      retry = 0;
      handlers.onOpen?.();
    });
    source.addEventListener('error', () => {
      // EventSource reconnects on its own; report state and back off for UI text.
      retry += 1;
      handlers.onError?.(retry);
    });
    source.addEventListener('message', (event) => {
      dispatch(event);
    });
    for (const type of [
      'run_created',
      'run_started',
      'run_finished',
      'plan_ready',
      'agent_created',
      'agent_started',
      'agent_status',
      'agent_event',
      'agent_stderr',
      'agent_finished',
      'log',
      'error',
    ]) {
      source.addEventListener(type, dispatch);
    }
  };

  const dispatch = (event) => {
    if (!event.data) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type && payload.type !== event.type) return;
    handlers.onEvent?.(payload);
  };

  connect();
  return {
    close() {
      closed = true;
      source?.close();
    },
  };
}