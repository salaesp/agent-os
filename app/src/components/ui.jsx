// Piezas de UI compartidas por los paneles.

export function PageHead({ title, sub, children }) {
  return (
    <div class="page-head">
      <div><h1>{title}</h1>{sub && <div class="sub">{sub}</div>}</div>
      {children}
    </div>
  );
}

export function Loading() {
  return <div class="center"><span class="msr" style="animation:spin 1s linear infinite">progress_activity</span></div>;
}

export function ErrorBox({ error }) {
  return (
    <div class="card" style="border:1px solid var(--err)">
      <div class="row"><span class="msr" style="color:var(--err)">error</span>
      <b>No se pudo cargar</b></div>
      <div class="muted mono" style="margin-top:6px">{error}</div>
    </div>
  );
}

// Estado → clase de punto (ok/err/warn/neutro)
export function stateDot(state) {
  const s = (state || '').toLowerCase();
  if (['running', 'connected', 'ok', 'active', 'done', 'scheduled'].includes(s)) return 'ok';
  if (['error', 'failed', 'disconnected'].includes(s)) return 'err';
  if (['paused', 'blocked', 'pending', 'connecting'].includes(s)) return 'warn';
  return '';
}

export function Dot({ state }) { return <span class={`dot ${stateDot(state)}`} />; }

// Tiempo relativo compacto en español.
export function rel(iso) {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const s = Math.round((d - Date.now()) / 1000);
  const abs = Math.abs(s);
  const fmt = (n, u) => `${n}${u}`;
  let str;
  if (abs < 60) str = fmt(abs, 's');
  else if (abs < 3600) str = fmt(Math.round(abs / 60), 'm');
  else if (abs < 86400) str = fmt(Math.round(abs / 3600), 'h');
  else str = fmt(Math.round(abs / 86400), 'd');
  return s < 0 ? `hace ${str}` : `en ${str}`;
}
