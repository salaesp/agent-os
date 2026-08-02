// Text-to-speech vía OpenRouter (/api/v1/audio/speech, mismo shape que la API
// de OpenAI). La API key se resuelve en vivo desde Bitwarden (secrets.js —
// mismo mecanismo que ya usa Hermes para SUS secretos), con un override
// manual opcional por entorno. Nunca se guarda en texto plano en el repo.
import { config } from './config.js';
import { getSecretValue } from './secrets.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/speech';
const DEFAULT_MODEL = 'openai/gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const MAX_CHARS = 20_000; // defensivo: evita facturas sorpresa por documentos gigantes

async function resolveApiKey() {
  return config.openrouterApiKey || (await getSecretValue('OPENROUTER_API_KEY'));
}

export async function ttsAvailable() {
  return Boolean(await resolveApiKey());
}

// Devuelve { ok, buffer, mime } o { ok:false, error }.
export async function synthesize(text, { model = DEFAULT_MODEL, voice = DEFAULT_VOICE } = {}) {
  const apiKey = await resolveApiKey();
  if (!apiKey) return { ok: false, error: 'sin OPENROUTER_API_KEY (ni override, ni en Bitwarden)' };
  const input = String(text || '').trim().slice(0, MAX_CHARS);
  if (!input) return { ok: false, error: 'texto vacío' };

  let resp;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input, voice, response_format: 'mp3' }),
    });
  } catch (e) {
    return { ok: false, error: `red: ${e.message}` };
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return { ok: false, error: `openrouter ${resp.status}: ${detail.slice(0, 300)}` };
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  return { ok: true, buffer, mime: 'audio/mpeg' };
}
