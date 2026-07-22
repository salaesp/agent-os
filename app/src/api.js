// Cliente de la API neutral del Agent OS. Patrón simple fetch (base relativa;
// en dev Vite proxya /api → :8082). Preparado para sumar bearer/SSE en la fase
// de chat, igual que hermes-mobileui/app/src/api.js.
const BASE = '';

export async function get(path) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

export async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.stdout || data.error || data.stderr || `HTTP ${res.status}`);
  return data;
}

import { useEffect, useState } from 'preact/hooks';

// Hook de carga con auto-refresh opcional. Expone `reload()` para refrescar a mano.
export function useApi(path, refreshMs = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => get(path)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState((s) => ({ ...s, error: error.message, loading: false })));
    load();
    const t = refreshMs ? setInterval(load, refreshMs) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [path, refreshMs, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}
