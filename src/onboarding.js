// Onboarding: detecta software instalado en la máquina y expone la config de ROI
// (minutos ahorrados por invocación de skill + valor de la hora) que consume Analytics.
import { execFile } from 'node:child_process';

const TOOLS = [
  { name: 'node', label: 'Node.js', vflag: '--version' },
  { name: 'python3', label: 'Python', vflag: '--version' },
  { name: 'git', label: 'Git', vflag: '--version' },
  { name: 'gh', label: 'GitHub CLI', vflag: '--version' },
  { name: 'hermes', label: 'Hermes Agent', vflag: null },
  { name: 'bws', label: 'Bitwarden SM', vflag: null },
  { name: 'podman', label: 'Podman', vflag: '--version' },
  { name: 'docker', label: 'Docker', vflag: '--version' },
  { name: 'ollama', label: 'Ollama', vflag: null },
  { name: 'tailscale', label: 'Tailscale', vflag: null },
  { name: 'ffmpeg', label: 'ffmpeg', vflag: '-version' },
  { name: 'rg', label: 'ripgrep', vflag: '--version' },
  { name: 'jq', label: 'jq', vflag: '--version' },
  { name: 'curl', label: 'curl', vflag: '--version' },
];

function which(tool) {
  return new Promise((resolve) => {
    execFile('which', [tool], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? null : (stdout || '').trim().split('\n')[0] || null);
    });
  });
}
function version(tool, flag) {
  if (!flag) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(tool, [flag], { timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || stderr || '').trim().split('\n')[0] || null;
      resolve(err && !out ? null : out);
    });
  });
}

export async function detectSoftware() {
  const results = await Promise.all(TOOLS.map(async (t) => {
    const path = await which(t.name);
    const ver = path ? await version(t.name, t.vflag) : null;
    return { name: t.name, label: t.label, found: !!path, path, version: ver };
  }));
  return { ok: true, tools: results, found: results.filter((r) => r.found).length, total: results.length };
}
