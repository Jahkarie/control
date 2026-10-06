// emails.js: one shared look for every email On D' Road sends.
// Pass plain text only; everything is escaped here. Returns { html, text }.

const C = {
  bg: '#0b0a09', card: '#141210', inset: '#1d1a17', line: '#2b2723',
  text: '#f3ece2', body: '#c9c1b6', muted: '#9b9389', dim: '#6c665e',
  accent: '#ff5b1f', good: '#4fc3a1', warn: '#f0b43c', bad: '#ff6a5c'
};
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "Menlo, Consolas, 'Courier New', monospace";

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

/**
 * @param {object} o
 * @param {string} o.title       Big headline, e.g. "You're in"
 * @param {string} o.tag         Small label above it, e.g. "Payment confirmed"
 * @param {'accent'|'good'|'warn'|'bad'} [o.tone]  Color of the top bar and tag
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
  const tone = C[o.tone] || C.accent;
  const lines = (o.lines || []).filter(Boolean);
  const details = (o.details || []).filter((d) => d && d[1] !== undefined && d[1] !== null && d[1] !== '');
  const rows = [];

  rows.push(`<tr><td class="px" style="padding:34px 32px 0;">
<p style="margin:0 0 14px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:${tone};">&#9679;&nbsp; ${esc(o.tag)}</p>
<h1 style="margin:0;font-family:${FONT};font-size:34px;line-height:1.05;font-weight:800;letter-spacing:-0.5px;text-transform:uppercase;color:${C.text};">${esc(o.title)}</h1>
</td></tr>`);

  if (lines.length) {
    rows.push(`<tr><td class="px" style="padding:18px 32px 0;">${lines.map((l, i) => i === 0
      ? `<p style="margin:0 0 10px;font-family:${FONT};font-size:17px;line-height:1.55;font-weight:600;color:${C.text};">${esc(l)}</p>`
      : `<p style="margin:0 0 10px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.body};">${esc(l)}</p>`).join('')}</td></tr>`);
  }

  if (o.quote && o.quote.text) {
    rows.push(`<tr><td class="px" style="padding:14px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.inset}" style="background-color:${C.inset};border-radius:12px;"><tr><td style="padding:18px 20px;">
<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.dim};">Message from ${esc(o.quote.from)}</p>
<p style="margin:0;font-family:Georgia, 'Times New Roman', serif;font-style:italic;font-size:17px;line-height:1.5;color:${C.text};">&ldquo;${esc(o.quote.text)}&rdquo;</p>
</td></tr></table></td></tr>`);
  }

  if (o.image && o.image.src) {
    rows.push(`<tr><td class="px" align="center" style="padding:22px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:14px;"><tr><td style="padding:14px;">
<img src="${esc(o.image.src)}" width="220" height="220" alt="${esc(o.image.alt)}" style="display:block;width:220px;height:220px;border:0;">
</td></tr></table>
${o.image.caption ? `<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${C.muted};">${esc(o.image.caption)}</p>` : ''}
</td></tr>`);
  }

  if (details.length) {
    rows.push(`<tr><td class="px" style="padding:18px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.inset}" style="background-color:${C.inset};border:1px solid ${C.line};border-radius:12px;">
${details.map((d, i) => `<tr>
<td style="padding:13px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${C.dim};white-space:nowrap;">${esc(d[0])}</td>
<td align="right" style="padding:13px 16px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${d[2] ? MONO : FONT};font-size:${d[2] ? 13 : 15}px;font-weight:600;color:${C.text};">${esc(d[1])}</td>
</tr>`).join('')}
</table></td></tr>`);
  }

  if (o.callout && o.callout.text) {
    rows.push(`<tr><td class="px" style="padding:18px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.inset}" style="background-color:${C.inset};border-left:3px solid ${C.accent};border-radius:0 12px 12px 0;"><tr><td style="padding:16px 18px;">
<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.accent};">${esc(o.callout.label)}</p>
<p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};">${nl2br(o.callout.text)}</p>
</td></tr></table></td></tr>`);
  }

  if (o.cta && o.cta.url) {
    rows.push(`<tr><td class="px" style="padding:28px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="${C.accent}" style="background-color:${C.accent};border-radius:10px;">
<a href="${esc(o.cta.url)}" target="_blank" style="display:inline-block;padding:16px 30px;font-family:${FONT};font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#120703;text-decoration:none;border-radius:10px;">${esc(o.cta.text)} &rarr;</a>
</td></tr></table>
${o.cta.fallback ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">Button not working? Paste this link into your browser:<br><a href="${esc(o.cta.url)}" style="color:${C.muted};word-break:break-all;">${esc(o.cta.url)}</a></p>` : ''}
</td></tr>`);
  }

  if (o.fine) {
    rows.push(`<tr><td class="px" style="padding:24px 32px 0;"><p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.dim};">${esc(o.fine)}</p></td></tr>`);
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
  .outer { padding: 24px 10px 32px !important; }
  h1 { font-size: 30px !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background-color:${C.bg};">
<tr><td class="outer" align="center" style="padding:36px 16px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 6px 18px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font-family:${FONT};font-size:16px;font-weight:800;letter-spacing:2px;color:${C.text};">ON D<span style="color:${C.accent};">'</span> ROAD</td>
<td align="right" style="font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${C.dim};">18+ &middot; Invite only</td>
</tr></table>
</td></tr>
<tr><td bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td height="4" bgcolor="${tone}" style="height:4px;line-height:4px;font-size:0;background-color:${tone};border-radius:16px 16px 0 0;">&nbsp;</td></tr>
${rows.join('\n')}
<tr><td height="34" style="height:34px;line-height:34px;font-size:0;">&nbsp;</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:22px 16px 0;font-family:${FONT};font-size:11px;line-height:1.7;color:${C.dim};">
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
