// Nombre para mostrar de cada perfil. El backend usa '(default)' (HERMES_HOME);
// en la UI el default se muestra como "Alfred" (su SOUL es Alfred el mayordomo).
export const personaLabel = (p) => (p === '(default)' || p === 'default' || !p) ? 'Alfred' : p;
