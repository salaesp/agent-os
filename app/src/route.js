// Router mínimo por hash con parámetros: #/vista?clave=valor
export function currentView() {
  return (location.hash.replace(/^#\//, '').split('?')[0]) || 'overview';
}
export function routeParam(key) {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get(key);
}
export function go(view, params) {
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : '';
  location.hash = `#/${view}${qs}`;
}
