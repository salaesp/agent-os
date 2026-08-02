function timestampMs(value) {
  if (typeof value === 'number') return Math.abs(value) < 1e12 ? value * 1000 : value;
  return new Date(value).getTime();
}

// Tiempo relativo compacto en español. Acepta ISO y timestamps Unix en segundos o milisegundos.
export function rel(value, now = Date.now()) {
  if (!value) return '—';
  const d = timestampMs(value);
  if (Number.isNaN(d)) return '—';
  const s = Math.round((d - now) / 1000);
  const abs = Math.abs(s);
  const fmt = (n, u) => `${n}${u}`;
  let str;
  if (abs < 60) str = fmt(abs, 's');
  else if (abs < 3600) str = fmt(Math.round(abs / 60), 'm');
  else if (abs < 86400) str = fmt(Math.round(abs / 3600), 'h');
  else str = fmt(Math.round(abs / 86400), 'd');
  return s < 0 ? `hace ${str}` : `en ${str}`;
}
