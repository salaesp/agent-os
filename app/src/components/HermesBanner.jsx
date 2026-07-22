import { HERMES_LOGO, HERMES_CADUCEUS } from './hermesArt.js';

// Renderiza arte ASCII de Hermes (cada fila con su color dorado) en monospace.
// `art`: HERMES_LOGO | HERMES_CADUCEUS. `size`: font-size en px (o clamp por CSS).
export function AsciiArt({ art, class: cls = '', style = '' }) {
  return (
    <pre class={`ascii ${cls}`} style={style} aria-hidden="true">
      {art.map((row, i) => (
        <div key={i} style={`color:${row.c}`}>{row.t}</div>
      ))}
    </pre>
  );
}

export function HermesLogo(props) { return <AsciiArt art={HERMES_LOGO} {...props} />; }
export function HermesCaduceus(props) { return <AsciiArt art={HERMES_CADUCEUS} {...props} />; }
