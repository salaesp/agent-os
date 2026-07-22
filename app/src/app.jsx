import { useEffect, useState } from 'preact/hooks';
import { Overview } from './panels/Overview.jsx';
import { Connections } from './panels/Connections.jsx';
import { Pantheon } from './panels/Pantheon.jsx';
import { Crons } from './panels/Crons.jsx';
import { Kanban } from './panels/Kanban.jsx';
import { MissionControl } from './panels/MissionControl.jsx';
import { Dreaming } from './panels/Dreaming.jsx';
import { Suggestions } from './panels/Suggestions.jsx';
import { Profile } from './panels/Profile.jsx';
import { Costs } from './panels/Costs.jsx';
import { Chat } from './panels/Chat.jsx';
import { Obsidian } from './panels/Obsidian.jsx';
import { HermesCaduceus } from './components/HermesBanner.jsx';
import { GlobalSearch } from './components/GlobalSearch.jsx';
import { currentView } from './route.js';

// Nav del Agent OS (12 secciones). El buscador es global (titlebar). Analytics,
// Aprobaciones y Documentos salieron; Memoria se fusionó en Perfil; Obsidian aparte.
const VIEWS = [
  { id: 'overview', label: 'Inicio', icon: 'dashboard', comp: Overview },
  { id: 'chat', label: 'Chat', icon: 'forum', comp: Chat },
  { id: 'suggestions', label: 'Sugerencias', icon: 'lightbulb', comp: Suggestions },
  { id: 'mission', label: 'Mission Control', icon: 'flag', comp: MissionControl },
  { id: 'dreaming', label: 'Dreaming', icon: 'bedtime', comp: Dreaming },
  { id: 'profile', label: 'Perfil', icon: 'person', comp: Profile },
  { id: 'obsidian', label: 'Obsidian', icon: 'menu_book', comp: Obsidian },
  { id: 'connections', label: 'Conexiones', icon: 'hub', comp: Connections },
  { id: 'pantheon', label: 'Pantheon', icon: 'auto_awesome', comp: Pantheon },
  { id: 'costs', label: 'Costos', icon: 'payments', comp: Costs },
  { id: 'crons', label: 'Crons', icon: 'schedule', comp: Crons },
  { id: 'kanban', label: 'Kanban', icon: 'view_kanban', comp: Kanban },
];

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [theme, setTheme] = useState(document.documentElement.getAttribute('data-theme') || 'dark');

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    setTheme(next);
  };

  const view = VIEWS.some((v) => v.id === currentView()) ? currentView() : 'overview';
  const active = VIEWS.find((v) => v.id === view) || VIEWS[0];
  const Active = active.comp;

  return (
    <div class="window">
      <header class="titlebar">
        <div class="titlebar-title"><b>Agent OS</b></div>
        <GlobalSearch />
        <button class="icon-btn" onClick={toggleTheme} title="Tema claro/oscuro">
          <span class="msr">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
        </button>
      </header>
      <div class="shell">
        <nav class="sidebar">
          <div class="side-label">Agente</div>
          {VIEWS.map((v) => (
            <a class={`nav-item ${view === v.id ? 'active' : ''}`} href={`#/${v.id}`} key={v.id}>
              <span class="msr">{v.icon}</span>
              <span class="label">{v.label}</span>
            </a>
          ))}
          <div class="spacer" />
          <div class="caduceus-wrap"><HermesCaduceus /></div>
        </nav>
        <main class="content">
          <Active key={hash} />
        </main>
      </div>
    </div>
  );
}
