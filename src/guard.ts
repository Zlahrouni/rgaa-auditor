// SPDX-License-Identifier: AGPL-3.0-or-later
// Decides what the browser may do. Configured by the person (environment), never by the AI or the page.

export interface Policy { origins: string[]; sandbox: boolean; allowWrites: string[] }

export function policyFromEnv(env: Record<string, string | undefined> = process.env): Policy {
  const origins = (env.RGAA_ALLOWED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean);
  return {
    origins: origins.map((o) => new URL(o).origin),
    sandbox: env.RGAA_SANDBOX === '1',
    allowWrites: (env.RGAA_ALLOW_WRITES ?? '').split(';').map((s) => s.trim()).filter(Boolean),
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function isLoopback(url: string): boolean {
  const h = new URL(url).hostname;
  return LOOPBACK.has(h) || h.endsWith('.localhost');
}

/** Local addresses are allowed by default; anything else must be listed by the person. */
export function originAllowed(url: string, p: Policy): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return isLoopback(url) || p.origins.includes(u.origin);
}

export interface Req { url: string; method: string; mainNavigation: boolean }
export type Decision = { allow: true } | { allow: false; why: string };

export function decide(r: Req, p: Policy): Decision {
  let u: URL;
  try { u = new URL(r.url); } catch { return { allow: false, why: 'invalid url' }; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || r.url === 'about:blank') return { allow: true };
  if (r.mainNavigation && !originAllowed(r.url, p)) return { allow: false, why: 'navigation outside the authorised origins' };
  if (['GET', 'HEAD', 'OPTIONS'].includes(r.method)) return { allow: true };
  if (p.sandbox && isLoopback(r.url)) return { allow: true };
  if (originAllowed(r.url, p) && p.allowWrites.includes(`${r.method} ${u.origin}${u.pathname}`)) return { allow: true };
  return { allow: false, why: `write blocked (${r.method})` };
}

// Read requests can also have effects (logout, delete links), so these names stop a click.
const DANGER = /(supprim|effacer|déconne|deconne|logout|log out|sign out|delete|remove|payer|paiement|pay now|acheter|\bbuy\b|commander|signer|résilier|resilier|désinscri|desinscri|unsubscribe|clôturer|cloturer|télédéclar|teledeclar|valider définitivement|soumettre définitivement)/i;
export function dangerous(name: string): boolean { return DANGER.test(name.normalize('NFC')); }
