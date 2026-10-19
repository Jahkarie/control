// emails.js: one shared look for every email On D' Road sends ("Night Kinetic": matte charcoal, one safety-orange accent).
// Pass plain text only; everything is escaped here. Returns { html, text }.
// Built for email clients: tables, inline styles and bgcolor attributes, square corners and hairline rules. The type uses
// fonts already on the reader's device, never web fonts: a heavy wide face for the wordmark and headlines, a monospace
// for bracket tags and codes.

const C = {
  bg: '#0a0a0b', card: '#141416', band: '#0a0a0b', line: '#2c2c31', row: '#26262b',
  text: '#ecebe6', body: '#cfcec9', muted: '#a6a59f', dim: '#8a8983',
  ink: '#141416', ink2: '#47463f', concrete: '#c9c8c3', paperLine: '#8f8e88',
  orange: '#ff5a1f', acid: '#b6ff3b', amber: '#ffc02e', red: '#ff7a6b'
};
// Tone of the bracket tag and the short rule under the headline. The button is always orange.
const TONE = { accent: C.orange, good: C.acid, warn: C.amber, bad: C.red };
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "Menlo, Consolas, 'SF Mono', 'Courier New', monospace";
// Heavy and wide, like the site's expanded Archivo: Arial Black on Windows and Mac, then any bold sans.
const DISPLAY = "'Arial Black', 'Arial Bold', Gadget, 'Helvetica Neue', Helvetica, Arial, sans-serif";
// The thin "ROAD": Helvetica Neue Light where there is one.
const THIN = "'Helvetica Neue', 'HelveticaNeue-Light', Helvetica, Arial, sans-serif";

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

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
// A solid block of colour h px tall (a <td>). Empty cells stay put in every client thanks to the &nbsp;.
const bar = (h, color, attrs = '') =>
  `<td${attrs} height="${h}" bgcolor="${color}" style="height:${h}px;line-height:${h}px;font-size:0;background-color:${color};">&nbsp;</td>`;

// The wordmark: heavy "ON D'" with the orange apostrophe, then a thin, tracked "ROAD".
const wordmark = (size, color = C.text) =>
  `<span style="font-family:${DISPLAY};font-weight:900;font-size:${size}px;letter-spacing:0.5px;color:${color};">ON&nbsp;D<span style="color:${C.orange};">'</span></span>`
  + `<span style="font-family:${THIN};font-weight:300;font-size:${size}px;letter-spacing:${Math.round(size * 0.14)}px;color:${color};">&nbsp;ROAD</span>`;

// A bracket tag in mono: [ TEXT ]. The brackets stay quiet; the text takes the colour.
const bracket = (text, color, bracketColor, size = 11) =>
  `<span style="font-family:${MONO};font-size:${size}px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:${bracketColor};white-space:nowrap;">[&nbsp;<span style="color:${color};font-weight:700;">${esc(text)}</span>&nbsp;]</span>`;

/**
 * @param {object} o
 * @param {string} o.title       Big headline, e.g. "You're in"
 * @param {string} o.tag         Small label above it, e.g. "Payment confirmed"
 * @param {'accent'|'good'|'warn'|'bad'} [o.tone]  Color of the tag and the rule under the headline
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

  rows.push(`<tr><td class="px" style="padding:34px 32px 0;">
${o.tag ? `<p style="margin:0 0 14px;">${bracket(o.tag, tone, C.dim)}</p>` : ''}
<h1 style="margin:0;font-family:${DISPLAY};font-size:34px;line-height:1.06;font-weight:900;letter-spacing:0.3px;text-transform:uppercase;color:${C.text};word-wrap:break-word;overflow-wrap:break-word;">${esc(o.title)}</h1>
<table ${TABLE} width="44" style="width:44px;margin-top:18px;"><tr>${bar(3, tone)}</tr></table>
</td></tr>`);

  if (lines.length) {
    rows.push(`<tr><td class="px" style="padding:22px 32px 0;">${lines.map((l, i) => i === 0
      ? `<p style="margin:0 0 12px;font-family:${FONT};font-size:17px;line-height:1.5;font-weight:700;color:${C.text};">${esc(l)}</p>`
      : `<p style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${esc(l)}</p>`).join('')}</td></tr>`);
  }

  if (o.quote && o.quote.text) {
    rows.push(`<tr><td class="px" style="padding:12px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.band}" style="background-color:${C.band};border-left:2px solid ${C.orange};"><tr><td style="padding:16px 20px 18px;">
<p style="margin:0 0 8px;font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};">Message from ${esc(o.quote.from)}</p>
<p style="margin:0;font-family:${FONT};font-size:16px;line-height:1.55;color:${C.text};"><span style="color:${C.orange};font-weight:700;">&ldquo;</span>${esc(o.quote.text)}<span style="color:${C.orange};font-weight:700;">&rdquo;</span></p>
</td></tr></table></td></tr>`);
  }

  // The image (the QR entry pass) is a concrete ticket with a black wordmark bar; the code itself stays black on white.
  if (o.image && o.image.src) {
    const img = `<img src="${esc(o.image.src)}" width="220" height="220" alt="${esc(o.image.alt)}" style="display:block;width:220px;height:220px;border:0;">`;
    rows.push(`<tr><td class="px" style="padding:24px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.concrete}" style="background-color:${C.concrete};">
<tr><td bgcolor="${C.band}" style="background-color:${C.band};padding:14px 18px;">
<table ${TABLE} width="100%"><tr>
<td valign="middle" style="white-space:nowrap;line-height:20px;">${wordmark(16)}</td>
<td class="hide-sm" align="right" valign="middle" style="font-family:${MONO};font-size:10px;line-height:14px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};white-space:nowrap;">Entry pass</td>
</tr></table></td></tr>
<tr><td align="center" style="padding:24px 16px 22px;">
<p style="margin:0 0 16px;font-family:${MONO};font-size:11px;line-height:16px;letter-spacing:3px;text-transform:uppercase;color:${C.ink2};">Admit one</p>
<table ${TABLE} align="center"><tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid ${C.ink};padding:12px;">${img}</td></tr></table>
${o.image.caption ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:14px;line-height:1.5;font-weight:700;color:${C.ink};">${esc(o.image.caption)}</p>` : ''}
</td></tr>
<tr><td style="padding:11px 18px 12px;border-top:1px dashed ${C.paperLine};">
<table ${TABLE} width="100%"><tr>
<td style="font-family:${MONO};font-size:10px;line-height:14px;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink2};white-space:nowrap;">[&nbsp;18+&nbsp;|&nbsp;Antigua&nbsp;]</td>
<td align="right" style="font-family:${MONO};font-size:10px;line-height:14px;letter-spacing:1px;color:${C.ink2};white-space:nowrap;">17&deg;07'N &middot; 61&deg;50'W</td>
</tr></table></td></tr>
</table>
</td></tr>`);
  }

  if (details.length) {
    rows.push(`<tr><td class="px" style="padding:24px 32px 0;">
<table ${TABLE} width="100%" style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};">
${details.map((d, i) => `<tr>
<td class="dl" valign="top" style="padding:13px 10px 12px 0;${i ? `border-top:1px solid ${C.row};` : ''}font-family:${MONO};font-size:11px;line-height:20px;letter-spacing:1.5px;text-transform:uppercase;color:${C.muted};white-space:nowrap;">${esc(d[0])}</td>
<td class="dv" align="right" valign="top" style="padding:12px 0 12px 10px;${i ? `border-top:1px solid ${C.row};` : ''}font-family:${d[2] ? MONO : FONT};font-size:${d[2] ? 14 : 15}px;line-height:22px;font-weight:700;${d[2] ? 'letter-spacing:0.5px;' : ''}color:${C.text};word-break:break-word;overflow-wrap:anywhere;">${esc(d[1])}</td>
</tr>`).join('')}
</table></td></tr>`);
  }

  // Utility info (how to pay) sits on a concrete panel, like the order panel on the site.
  if (o.callout && o.callout.text) {
    rows.push(`<tr><td class="px" style="padding:24px 32px 0;">
<table ${TABLE} width="100%" bgcolor="${C.concrete}" style="background-color:${C.concrete};"><tr><td style="padding:18px 20px 20px;">
<p style="margin:0;">${bracket(o.callout.label, C.ink, C.ink2)}</p>
<p style="margin:12px 0 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.ink};">${nl2br(o.callout.text)}</p>
</td></tr></table></td></tr>`);
  }

  // Button: a square block of safety orange with dark text.
  if (o.cta && o.cta.url) {
    const link = `<a href="${esc(o.cta.url)}" target="_blank" style="display:inline-block;padding:16px 26px;font-family:${DISPLAY};font-size:14px;line-height:18px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;color:${C.ink};text-decoration:none;">${esc(o.cta.text)}&nbsp;&nbsp;<span style="font-family:Arial, sans-serif;font-weight:700;">&rarr;</span></a>`;
    rows.push(`<tr><td class="px" style="padding:30px 32px 0;">
<table ${TABLE}><tr><td bgcolor="${C.orange}" style="background-color:${C.orange};mso-padding-alt:16px 26px;">${link}</td></tr></table>
${o.cta.fallback ? `<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">Button not working? Paste this link into your browser:<br><a href="${esc(o.cta.url)}" style="color:${C.muted};word-break:break-all;">${esc(o.cta.url)}</a></p>` : ''}
</td></tr>`);
  }

  if (o.fine) {
    rows.push(`<tr><td class="px" style="padding:28px 32px 0;"><table ${TABLE} width="100%"><tr><td style="padding-top:16px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">${esc(o.fine)}</td></tr></table></td></tr>`);
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
  .hide-sm { display: none !important; }
  h1 { font-size: 28px !important; }
  /* Detail rows stack: label over value, so long emails and names don't break mid-word */
  .dl, .dv { display: block !important; width: auto !important; text-align: left !important; }
  .dl { padding: 12px 0 2px !important; }
  .dv { padding: 0 0 12px !important; border-top: 0 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table ${TABLE} width="100%" bgcolor="${C.bg}" style="background-color:${C.bg};">
<tr><td class="outer" align="center" style="padding:32px 16px 40px;">
<table ${TABLE} width="100%" style="max-width:560px;">
<tr><td bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.row};">
<table ${TABLE} width="100%">
<tr><td class="px" bgcolor="${C.band}" style="background-color:${C.band};padding:20px 32px 19px;">
<table ${TABLE} width="100%"><tr>
<td valign="middle" style="white-space:nowrap;line-height:24px;">${wordmark(20)}</td>
<td class="hide-sm" align="right" valign="middle" style="font-family:${MONO};font-size:10px;line-height:14px;letter-spacing:2px;text-transform:uppercase;color:${C.muted};white-space:nowrap;">[&nbsp;18+&nbsp;|&nbsp;Antigua&nbsp;]</td>
</tr></table>
</td></tr>
<tr><td style="font-size:0;line-height:0;"><table ${TABLE} width="100%"><tr>${bar(2, C.orange, ' width="56"')}${bar(2, C.line)}</tr></table></td></tr>
${rows.join('\n')}
<tr><td height="36" style="height:36px;line-height:36px;font-size:0;">&nbsp;</td></tr>
</table>
</td></tr>
<tr><td style="padding:22px 2px 0;font-family:${FONT};font-size:11px;line-height:1.7;color:${C.dim};">
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
