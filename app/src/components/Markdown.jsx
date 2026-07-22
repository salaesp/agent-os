// Render de markdown minimalista y SEGURO (construye vnodes, sin innerHTML).
// Cubre lo común de los briefs/respuestas del agente: headings, listas, bold,
// inline code, links, blockquotes, reglas. No es CommonMark completo.

function inline(text, keyBase) {
  // Divide por **bold**, `code`, [txt](url) preservando el resto como texto.
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)]+)\))/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] != null) nodes.push(<strong key={keyBase + '-b' + i}>{m[2]}</strong>);
    else if (m[3] != null) nodes.push(<code key={keyBase + '-c' + i} class="mono" style="background:var(--panel-3);padding:1px 5px;border-radius:5px">{m[3]}</code>);
    else if (m[4] != null) nodes.push(<a key={keyBase + '-l' + i} href={m[5]} target="_blank" rel="noreferrer">{m[4]}</a>);
    last = m.index + m[0].length; i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let list = null, code = null, para = null;
  const flushPara = () => { if (para) { blocks.push(<p key={'p' + blocks.length} style="margin:6px 0">{inline(para, 'p' + blocks.length)}</p>); para = null; } };
  const flushList = () => { if (list) { blocks.push(<ul key={'u' + blocks.length} style="margin:6px 0;padding-left:20px">{list}</ul>); list = null; } };

  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (/^```/.test(l)) {
      if (code == null) { flushPara(); flushList(); code = []; }
      else { blocks.push(<pre key={'code' + blocks.length} style="background:var(--panel-2);padding:12px;border-radius:var(--radius-m);overflow:auto;font-family:var(--mono);font-size:12px;margin:8px 0">{code.join('\n')}</pre>); code = null; }
      continue;
    }
    if (code != null) { code.push(l); continue; }

    const h = l.match(/^(#{1,4})\s+(.+)$/);
    const li = l.match(/^\s*[-*]\s+(.+)$/);
    const bq = l.match(/^>\s?(.*)$/);

    if (h) { flushPara(); flushList(); const lvl = h[1].length; const Tag = `h${Math.min(4, lvl + 1)}`;
      blocks.push(<Tag key={'h' + blocks.length} style={`margin:14px 0 6px;font-size:${19 - lvl * 1.5}px;font-weight:700`}>{inline(h[2], 'h' + blocks.length)}</Tag>); continue; }
    if (li) { flushPara(); (list = list || []).push(<li key={'li' + idx} style="margin:2px 0">{inline(li[1], 'li' + idx)}</li>); continue; }
    if (bq) { flushPara(); flushList(); blocks.push(<blockquote key={'bq' + blocks.length} style="margin:8px 0;padding:6px 12px;border-left:3px solid var(--gold);color:var(--text-2)">{inline(bq[1], 'bq' + blocks.length)}</blockquote>); continue; }
    if (/^(-{3,}|_{3,})$/.test(l.trim())) { flushPara(); flushList(); blocks.push(<hr key={'hr' + blocks.length} style="border:none;border-top:1px solid var(--hairline);margin:12px 0" />); continue; }
    if (l.trim() === '') { flushPara(); flushList(); continue; }
    para = para ? para + ' ' + l : l;
  }
  flushPara(); flushList();
  return <div class="md">{blocks}</div>;
}
