// Interfaz NEUTRAL del agente. El resto del backend y todo el frontend hablan
// contra estos métodos y estos shapes — nunca contra Hermes directamente. Para
// migrar a OpenClaw se implementa otro adapter con la misma superficie.
//
// FASE 1: solo lecturas. Las escrituras (create/edit/run cron, kanban, memory,
// chat, approvals) se agregan en la fase de escrituras, todas a través del CLI /
// gateway del agente, nunca tocando su almacenamiento directo.
//
// Shapes neutrales (resumen):
//   Connection = { profile, gateway:{state,pid,active_agents,platforms{name:state}}, channels:[...], mcp:[{name,url,auth,enabled}] }
//   Persona    = { profile, name, model, provider, toolsets:[...], hasHooks, soulExcerpt }
//   Skill      = { category, name, description, tags:[...], useCount, viewCount, lastUsedAt, pinned, state }
//   Cron       = { profile, id, name, schedule, enabled, state, model, provider, deliver, nextRunAt, lastRunAt, lastStatus, completed }
//   CronRun    = { file, runAt } (+ detalle bajo demanda)
//   KanbanTask = { profile, id, title, status, assignee, priority, project, createdAt, completedAt }
//   Memory     = { profile, memory:{text,used,cap}, user:{text,used,cap}, soul:{text} }

export class AgentAdapter {
  /** @returns {Promise<{ok:boolean, profiles:string[], connections:Connection[]}>} */
  async getConnections() { throw new Error('not implemented'); }
  /** @returns {Promise<Persona[]>} */
  async getPersonas() { throw new Error('not implemented'); }
  /** @returns {Promise<{skills:Skill[], categories:string[]}>} */
  async getSkills() { throw new Error('not implemented'); }
  /** @returns {Promise<Cron[]>} */
  async getCrons() { throw new Error('not implemented'); }
  /** @param {string} profile @param {string} id @returns {Promise<CronRun[]>} */
  async getCronHistory(profile, id) { throw new Error('not implemented'); }
  /** @returns {Promise<{total:number, byStatus:object, tasks:KanbanTask[], projects:any[]}>} */
  async getKanban() { throw new Error('not implemented'); }
  /** @returns {Promise<Memory[]>} */
  async getMemory() { throw new Error('not implemented'); }
  /** Resumen para la home. @returns {Promise<object>} */
  async getOverview() { throw new Error('not implemented'); }
}
