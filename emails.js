// emails.js: one shared look for every email On D' Road sends ("Paint & Powder": neon paint on a black canvas).
// Pass plain text only; everything is escaped here. Returns { html, text }.
// Built for email clients: tables, inline styles and bgcolor attributes. Every bit of paint (stripes, drips, tape,
// the button's offset) is a table cell, and the type uses fonts already on the reader's device, never web fonts.

const C = {
  bg: '#09080b', card: '#131117', well: '#0c0b0f', line: '#2a2630', dash: '#3a3541',
  text: '#f6f1e8', body: '#d2cbd6', muted: '#b4adbb', dim: '#8f8898', ink: '#0b0a0d', paper: '#f6f1e8', paperText: '#433d48',
  pink: '#ff2e93', yellow: '#ffe500', cyan: '#1ee3ff', cyanSoft: '#1a8798', lime: '#a3ff2b', red: '#ff4d4d'
};
// Tone of the tag tape and the drip under the headline.
const TONE = { accent: C.pink, good: C.lime, warn: C.yellow, bad: C.red };
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "Menlo, Consolas, 'Courier New', monospace";
// Heavy, preferably condensed: Helvetica Neue Condensed Black on Apple devices, Arial Black on Windows,
// Roboto Condensed on Android, then any bold sans.
const DISPLAY = "'HelveticaNeue-CondensedBlack', 'Helvetica Neue Condensed Black', 'Arial Black', Impact, Haettenschweiler, 'Arial Narrow Bold', 'sans-serif-condensed', sans-serif";

// Contact details for the bottom of every email. site.js sets them from the admin's settings.
let contact = { whatsapp: '', instagram: '', email: '' };
export function setContact(c) {
  contact = { whatsapp: c?.whatsapp || '', instagram: c?.instagram || '', email: c?.email || '' };
}

// 12685551234 -> "+1 268 555 1234". Other numbers are shown as "+" and the digits.
export const formatPhone = (d) => (/^1\d{10}$/.test(d) ? `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : `+${d}`);

// [label, url] for each contact detail that is set.
export function contactLinks(c = contact) {
  const links = [];
  if (c.whatsapp) links.push([`WhatsApp ${formatPhone(c.whatsapp)}`, `https://wa.me/${c.whatsapp}`]);
  if (c.instagram) links.push([`Instagram @${c.instagram}`, `https://instagram.com/${c.instagram}`]);
  if (c.email) links.push([c.email, `mailto:${c.email}`]);
  return links;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br>');

// ---------- Paint, made of table cells ----------
const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
// A solid block of paint h px tall (a <td>). Empty cells stay put in every client thanks to the &nbsp;.
const paint = (h, color, style = '', attrs = '') =>
  `<td${attrs} height="${h}" bgcolor="${color}" style="height:${h}px;line-height:${h}px;font-size:0;background-color:${color};${style}">&nbsp;</td>`;
const gap = (w, unit = '%') => `<td width="${w}${unit === '%' ? '%' : ''}" style="${unit === 'px' ? `width:${w}px;` : ''}font-size:0;line-height:0;">&nbsp;</td>`;
// One drip hanging from a stripe: w wide (% or px), len px long, rounded at the bottom.
const drip = (w, len, color, unit = '%') => `<td width="${w}${unit === '%' ? '%' : ''}" valign="top" style="${unit === 'px' ? `width:${w}px;` : ''}font-size:0;line-height:0;">
<table ${TABLE} width="100%"><tr>${paint(len, color, 'border-radius:0 0 8px 8px;')}</tr></table></td>`;
// A row of drips. spec: [start, width, length, colour], in order; unit is '%' or 'px'; total = the row's width.
const drips = (spec, total, unit = '%') => {
  let at = 0;
  const cells = [];
  for (const [start, w, len, color] of spec) {
    if (start > at) cells.push(gap(start - at, unit));
    cells.push(drip(w, len, color, unit));
    at = start + w;
  }
  if (total > at) cells.push(gap(total - at, unit));
  return cells.join('');
};

// Paint stripe across the top of the card, with drips running off it.
const STRIPE = [[46, C.pink], [24, C.yellow], [18, C.cyan], [12, C.lime]];
const STRIPE_DRIPS = [[6, 3, 24, C.pink], [17, 1, 10, C.pink], [29, 2, 16, C.pink], [39, 1, 8, C.pink],
  [52, 2, 28, C.yellow], [62, 1, 12, C.yellow], [75, 2, 14, C.cyan], [92, 2, 18, C.lime]];
// The drip under the headline (px, in a 150px wide bar).
const HEAD_DRIPS = [[10, 7, 16], [39, 5, 9], [74, 8, 22], [102, 5, 8], [133, 4, 12]];

// Torn-tape label: a strip of colour with notched ends (stacked cells) and ink text, like the site's labels.
function tape(text, color, size = 11) {
  const rows = 6; // 6 x 4px = the strip's 24px height
  const teeth = (phase) => `<td width="3" valign="top" style="width:3px;font-size:0;line-height:0;">
<table ${TABLE} width="3">${Array.from({ length: rows }, (_, i) => `<tr>${(i + phase) % 2 ? `<td height="4" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td>` : paint(4, color)}</tr>`).join('')}</table></td>`;
  return `<table ${TABLE}><tr>${teeth(0)}<td bgcolor="${color}" style="background-color:${color};padding:5px 9px 5px 8px;font-family:${MONO};font-size:${size}px;line-height:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">${esc(text)}</td>${teeth(1)}</tr></table>`;
}

// A box with a solid block of colour offset d px down and to the right behind it (the site's sticker look),
// built from two cells of colour: one to the right of the box and one under it. Each starts d px in, by
// covering its first d px with a border in the colour of the surface around it (borders paint over bgcolor).
// boxAttrs: the box <td>'s attributes and style. surface: the background the whole thing sits on.
function offset(boxAttrs, content, color, surface, d = 6, align = '') {
  return `<table ${TABLE}${align ? ` align="${align}"` : ''}>
<tr><td ${boxAttrs}>${content}</td><td width="${d}" bgcolor="${color}" style="width:${d}px;font-size:0;line-height:0;background-color:${color};border-top:${d}px solid ${surface};">&nbsp;</td></tr>
<tr>${paint(d, color, `border-left:${d}px solid ${surface};`, ' colspan="2"')}</tr>
</table>`;
}

/**
 * @param {object} o
 * @param {string} o.title       Big headline, e.g. "You're in"
 * @param {string} o.tag         Small label above it, e.g. "Payment confirmed"
 * @param {'accent'|'good'|'warn'|'bad'} [o.tone]  Color of the tag and the drip under the headline
 * @param {string} [o.preheader] Inbox preview text
 * @param {string[]} [o.lines]   Paragraphs. The first one is emphasized.
 * @param {Array<[string, string, boolean?]>} [o.details]  Label/value rows; third item true = monospace value
 * @param {{from: string, text: string}} [o.quote]        Personal note
 * @param {{label: string, text: string}} [o.callout]     Boxed info such as "How to pay" (line breaks kept)
 * @param {{src: string, alt: string, caption?: string}} [o.image]  Centered image on white, e.g. the QR entry pass
 * @param {{text: string, url: string, fallback?: boolean}} [o.cta]  Button; fallback shows the raw link too
 * @param {string} [o.fine]      Small print under everything
 */
export function renderEmail(o) {
  const tone = TONE[o.tone] || TONE.accent;
  const lines = (o.lines || []).filter(Boolean);
  const details = (o.details || []).filter((d) => d && d[1] !== undefined && d[1] !== null && d[1] !== '');
  const rows = [];

  rows.push(`<tr><td class="px" style="padding:6px 32px 0;">
${o.tag ? `${tape(o.tag, tone)}<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>` : ''}
<h1 style="margin:0;font-family:${DISPLAY};font-size:40px;line-height:1.02;font-weight:900;letter-spacing:0;text-transform:uppercase;color:${C.text};word-wrap:break-word;overflow-wrap:break-word;">${esc(o.title)}</h1>
<table ${TABLE} width="150" style="width:150px;margin-top:14px;">
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="150"><tr>${paint(7, tone, 'border-radius:4px 2px 0 3px;')}</tr></table></td></tr>
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="150"><tr>${drips(HEAD_DRIPS.map(([s, w, l]) => [s, w, l, tone]), 150, 'px')}</tr></table></td></tr>
</table>
</td></tr>`);

  if (lines.length) {
    rows.push(`<tr><td class="px" style="padding:16px 32px 0;">${lines.map((l, i) => i === 0
      ? `<p style="margin:0 0 10px;font-family:${FONT};font-size:17px;line-height:1.55;font-weight:700;color:${C.text};">${esc(l)}</p>`
      : `<p style="margin:0 0 10px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${esc(l)}</p>`).join('')}</td></tr>`);
  }

  if (o.quote && o.quote.text) {
    rows.push(`<tr><td class="px" style="padding:14px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.well}" style="background-color:${C.well};border-left:4px solid ${C.pink};border-radius:0 12px 12px 0;"><tr><td style="padding:16px 20px 18px;">
<p style="margin:0 0 8px;font-family:${MONO};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.yellow};">Message from ${esc(o.quote.from)}</p>
<p style="margin:0;font-family:Georgia, 'Times New Roman', serif;font-style:italic;font-size:17px;line-height:1.5;color:${C.text};"><span style="color:${C.pink};font-weight:700;">&ldquo;</span>${esc(o.quote.text)}<span style="color:${C.pink};font-weight:700;">&rdquo;</span></p>
</td></tr></table></td></tr>`);
  }

  // The image (the QR entry pass) sits on white inside a paper "ticket", so it stays black on white.
  if (o.image && o.image.src) {
    const img = `<img src="${esc(o.image.src)}" width="220" height="220" alt="${esc(o.image.alt)}" style="display:block;width:220px;height:220px;border:0;">`;
    rows.push(`<tr><td class="px" align="center" style="padding:22px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.paper}" style="background-color:${C.paper};border-radius:4px 4px 12px 12px;">
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="100%"><tr>${paint(6, C.pink, 'border-radius:4px 0 0 0;', ' width="50%"')}${paint(6, C.yellow, '', ' width="30%"')}${paint(6, C.cyan, 'border-radius:0 4px 0 0;', ' width="20%"')}</tr></table></td></tr>
<tr><td align="center" style="padding:24px 16px 20px;">
${offset(`bgcolor="#ffffff" style="background-color:#ffffff;border:3px solid ${C.ink};padding:12px;"`, img, C.cyan, C.paper, 6, 'center')}
${o.image.caption ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;font-weight:700;color:${C.paperText};">${esc(o.image.caption)}</p>` : ''}
</td></tr></table>
</td></tr>`);
  }

  if (details.length) {
    rows.push(`<tr><td class="px" style="padding:20px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.well}" style="background-color:${C.well};border:1px solid ${C.line};border-bottom:4px solid ${C.pink};border-radius:10px 10px 0 0;">
${details.map((d, i) => `<tr>
<td valign="top" style="padding:14px 8px 13px 16px;${i ? `border-top:1px dashed ${C.dash};` : ''}font-family:${MONO};font-size:11px;line-height:18px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};white-space:nowrap;">${esc(d[0])}</td>
<td align="right" valign="top" style="padding:13px 16px 13px 8px;${i ? `border-top:1px dashed ${C.dash};` : ''}font-family:${d[2] ? MONO : FONT};font-size:${d[2] ? 14 : 15}px;line-height:20px;font-weight:700;${d[2] ? 'letter-spacing:0.5px;' : ''}color:${d[2] ? C.yellow : C.text};">${esc(d[1])}</td>
</tr>`).join('')}
</table></td></tr>`);
  }

  if (o.callout && o.callout.text) {
    rows.push(`<tr><td class="px" style="padding:20px 32px 0;">
<table ${TABLE} width="100%" style="border:2px dashed ${C.cyanSoft};border-radius:12px;"><tr><td style="padding:16px 18px 18px;">
${tape(o.callout.label, C.cyan)}
<p style="margin:12px 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};">${nl2br(o.callout.text)}</p>
</td></tr></table></td></tr>`);
  }

  // Sticker button: yellow with an ink ring and a pink block offset behind it.
  if (o.cta && o.cta.url) {
    const link = `<a href="${esc(o.cta.url)}" target="_blank" style="display:inline-block;padding:15px 26px 14px;font-family:${DISPLAY};font-size:18px;line-height:22px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink};text-decoration:none;">${esc(o.cta.text)}&nbsp;<span style="font-family:Arial, sans-serif;font-weight:700;">&rarr;</span></a>`;
    rows.push(`<tr><td class="px" style="padding:28px 32px 0;">
${offset(`bgcolor="${C.yellow}" style="background-color:${C.yellow};border:3px solid ${C.ink};mso-padding-alt:15px 26px 14px;"`, link, C.pink, C.card, 6)}
${o.cta.fallback ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">Button not working? Paste this link into your browser:<br><a href="${esc(o.cta.url)}" style="color:${C.muted};word-break:break-all;">${esc(o.cta.url)}</a></p>` : ''}
</td></tr>`);
  }

  if (o.fine) {
    rows.push(`<tr><td class="px" style="padding:26px 32px 0;"><table ${TABLE} width="100%"><tr><td style="padding-top:16px;border-top:1px dashed ${C.dash};font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">${esc(o.fine)}</td></tr></table></td></tr>`);
  }

  const preheader = o.preheader || lines[0] || o.title;
  const links = contactLinks();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${esc(o.title)}</title>
<style>
@media (max-width: 480px) {
  .px { padding-left: 22px !important; padding-right: 22px !important; }
  .outer { padding: 20px 10px 32px !important; }
  h1 { font-size: 33px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table ${TABLE} width="100%" bgcolor="${C.bg}" style="background-color:${C.bg};">
<tr><td class="outer" align="center" style="padding:32px 16px 40px;">
<table ${TABLE} width="100%" style="max-width:560px;">
<tr><td style="padding:0 2px 16px;">
<table ${TABLE} width="100%"><tr>
<td valign="middle" style="font-family:${DISPLAY};font-size:24px;line-height:26px;font-weight:900;letter-spacing:0.5px;color:${C.text};white-space:nowrap;">ON D<span style="color:${C.yellow};">'</span> ROAD</td>
<td align="right" valign="middle"><table ${TABLE} align="right"><tr>
<td bgcolor="${C.cyan}" style="background-color:${C.cyan};padding:4px 7px 3px;font-family:${MONO};font-size:10px;line-height:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink};white-space:nowrap;">Invite only</td>
<td width="6" style="width:6px;font-size:0;line-height:0;">&nbsp;</td>
<td bgcolor="${C.pink}" style="background-color:${C.pink};padding:4px 7px 3px;border-radius:10px;font-family:${MONO};font-size:10px;line-height:13px;font-weight:700;letter-spacing:1px;color:${C.ink};white-space:nowrap;">18+</td>
</tr></table></td>
</tr></table>
</td></tr>
<tr><td bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:16px;">
<table ${TABLE} width="100%">
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="100%"><tr>${STRIPE.map(([w, color], i) => paint(10, color, i === 0 ? 'border-radius:15px 0 0 0;' : i === STRIPE.length - 1 ? 'border-radius:0 15px 0 0;' : '', ` width="${w}%"`)).join('')}</tr></table></td></tr>
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="100%"><tr>${drips(STRIPE_DRIPS, 100)}</tr></table></td></tr>
${rows.join('\n')}
<tr><td height="34" style="height:34px;line-height:34px;font-size:0;">&nbsp;</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:24px 16px 0;">
<table ${TABLE} align="center"><tr>${[C.pink, C.yellow, C.cyan, C.lime].map((c) => paint(4, c, 'width:18px;', ' width="18"')).join('')}</tr></table>
</td></tr>
<tr><td align="center" style="padding:14px 16px 0;font-family:${FONT};font-size:11px;line-height:1.7;color:${C.dim};">
${links.length ? `Questions? ${links.map(([label, url]) => `<a href="${esc(url)}" style="color:${C.muted};text-decoration:underline;">${esc(label)}</a>`).join(' &middot; ')}<br>` : ''}On D' Road &middot; Antigua Carnival<br>18+ only. Invite only. Please don't forward this email.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    "ON D' ROAD",
    '',
    String(o.tag || '').toUpperCase(),
    o.title,
    '',
    ...lines.flatMap((l) => [l, '']),
    ...(o.quote && o.quote.text ? [`Message from ${o.quote.from}:`, `"${o.quote.text}"`, ''] : []),
    ...(details.length ? [...details.map((d) => `${d[0]}: ${d[1]}`), ''] : []),
    ...(o.callout && o.callout.text ? [`${o.callout.label}:`, o.callout.text, ''] : []),
    ...(o.cta && o.cta.url ? [`${o.cta.text}: ${o.cta.url}`, ''] : []),
    ...(o.fine ? [o.fine, ''] : []),
    ...(links.length ? [`Questions? ${links.map(([label, url]) => (url.startsWith('mailto:') ? label : `${label}: ${url}`)).join(' · ')}`] : []),
    "On D' Road · Antigua Carnival · 18+ only. Invite only."
  ].join('\n');

  return { html, text };
}
