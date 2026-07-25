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
import { Console } from './panels/Console.jsx';
import { Obsidian } from './panels/Obsidian.jsx';
import { HermesCaduceus } from './components/HermesBanner.jsx';
import { GlobalSearch } from './components/GlobalSearch.jsx';
import { currentView } from './route.js';

// Nav del Agent OS: 13 secciones en 5 grupos, ordenados por CÓMO se usan —
// primero hablarle al agente, después lo que él te propone, después lo que se
// planifica y corre, después la memoria, y al final la infraestructura.
// El buscador es global (titlebar). Analytics, Aprobaciones y Documentos
// salieron; Memoria se fusionó en Perfil; Obsidian aparte.
// En mobile el sidebar pasa a barra horizontal y los títulos de grupo se
// ocultan por CSS: ahí esto es simplemente el orden de los íconos.
const GROUPS = [
  {
    label: 'Agente',
    items: [
      { id: 'overview', label: 'Inicio', icon: 'dashboard', comp: Overview },
      { id: 'chat', label: 'Chat', icon: 'forum', comp: Chat },
      { id: 'console', label: 'Consola', icon: 'terminal', comp: Console },
    ],
  },
  {
    label: 'Proactividad',
    items: [
      { id: 'suggestions', label: 'Sugerencias', icon: 'lightbulb', comp: Suggestions },
      { id: 'dreaming', label: 'Dreaming', icon: 'bedtime', comp: Dreaming },
    ],
  },
  {
    label: 'Planificación',
    items: [
      { id: 'mission', label: 'Mission Control', icon: 'flag', comp: MissionControl },
      { id: 'kanban', label: 'Kanban', icon: 'view_kanban', comp: Kanban },
      { id: 'crons', label: 'Crons', icon: 'schedule', comp: Crons },
    ],
  },
  {
    label: 'Memoria',
    items: [
      { id: 'profile', label: 'Perfil', icon: 'person', comp: Profile },
      { id: 'obsidian', label: 'Obsidian', icon: 'menu_book', comp: Obsidian },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { id: 'connections', label: 'Conexiones', icon: 'hub', comp: Connections },
      { id: 'pantheon', label: 'Pantheon', icon: 'auto_awesome', comp: Pantheon },
      { id: 'costs', label: 'Costos', icon: 'payments', comp: Costs },
    ],
  },
];

// Plano, para el routing: los grupos son presentación, no estructura de rutas.
const VIEWS = GROUPS.flatMap((g) => g.items);

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
          {GROUPS.map((g) => (
            <div class="nav-group" key={g.label}>
              <div class="side-label">{g.label}</div>
              {g.items.map((v) => (
                <a class={`nav-item ${view === v.id ? 'active' : ''}`} href={`#/${v.id}`} key={v.id}>
                  <span class="msr">{v.icon}</span>
                  <span class="label">{v.label}</span>
                </a>
              ))}
            </div>
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
