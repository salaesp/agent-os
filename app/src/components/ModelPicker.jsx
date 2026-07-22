import { useState } from 'preact/hooks';
import { useApi } from '../api.js';

// Selector de modelo compartido (crons + personas). Las opciones salen de
// /api/models (la cache del picker de Hermes + los modelos ya en uso),
// agrupadas por provider. "otro…" permite tipear un id a mano; `inherit`
// agrega la opción de heredar el default del perfil (para crons).
export function ModelPicker({ model, provider, inherit = false, busy = false, onSave, onCancel }) {
  const { data, loading } = useApi('/api/models');
  const [sel, setSel] = useState(model ? `${provider || 'openrouter'}|${model}` : '');
  const [custom, setCustom] = useState('');
  const [customProv, setCustomProv] = useState(provider || 'openrouter');

  const providers = data?.providers || [];
  const provNames = providers.length ? providers.map((p) => p.name) : ['openrouter', 'anthropic', 'copilot'];
  const isCustom = sel === '@custom';
  const value = isCustom
    ? { model: custom.trim(), provider: customProv }
    : sel
      ? { model: sel.slice(sel.indexOf('|') + 1), provider: sel.slice(0, sel.indexOf('|')) }
      : { model: null, provider: null };
  const valid = isCustom ? !!custom.trim() : (!!sel || inherit);

  return (
    // minmax(0,1fr): sin esto la columna del grid se dimensiona al max-content
    // del <select> (ids de modelo largos) y desborda tarjetas angostas.
    <div style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px">
      <div class="search">
        <select value={sel} onChange={(e) => setSel(e.target.value)} disabled={busy}>
          {inherit
            ? <option value="">— heredar el modelo del perfil —</option>
            : !model && <option value="" disabled>elegí un modelo…</option>}
          {providers.map((p) => (
            <optgroup label={p.name === 'moa' ? 'moa — mixture of agents (presets)' : p.name} key={p.name}>
              {p.models.map((m) => <option value={`${p.name}|${m}`} key={m}>{m}</option>)}
            </optgroup>
          ))}
          <option value="@custom">otro… (tipear id a mano)</option>
        </select>
      </div>
      {isCustom && (
        <>
          <div class="wrap" style="align-items:center">
            <span class="muted" style="font-size:12px">Provider:</span>
            {provNames.map((p) => (
              <button class={`chip small filter-chip ${customProv === p ? 'on' : ''}`} onClick={() => setCustomProv(p)} key={p}>{p}</button>
            ))}
          </div>
          <div class="search"><input placeholder="Id del modelo — ej: z-ai/glm-5.2" value={custom} onInput={(e) => setCustom(e.target.value)} /></div>
        </>
      )}
      <div class="wrap">
        <button class="chip filter-chip on" disabled={busy || loading || !valid} onClick={() => onSave(value)}>{busy ? 'Guardando…' : 'Guardar'}</button>
        <button class="chip" disabled={busy} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}
