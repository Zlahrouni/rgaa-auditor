// SPDX-License-Identifier: AGPL-3.0-or-later
// Builds what the AI must judge next: the official text plus the facts measured for that theme.
import { NO_INSTRUMENT, criterionOf, needsFor, pageStatus, type Audit, type Evidence } from './ledger.ts';
import type { Criterion, Pack } from './pack.ts';
import type { Store } from './store.ts';

const latest = (a: Audit, page: string, kind: string): Evidence | undefined => a.evidence.filter((e) => e.page === page && e.kind === kind).at(-1);
const drop = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) => v === null || v === '' || (Array.isArray(v) && v.length === 0) ? undefined : v));

/** Facts by theme. Large lists stay in the evidence file and can be paged with evidence_get. */
function facts(store: Store, a: Audit, page: string, theme: number): Record<string, unknown> {
  const get = (k: string): any => { const e = latest(a, page, k); return e ? JSON.parse(store.readEvidence(a, e)) : null; };
  const inv = get('inventory');
  const axe = (get('axe')?.results ?? []).filter((r: any) => r.criteria.some((c: string) => c.startsWith(`${theme}.`)));
  const kb = () => { const k = get('keyboard'); return k && { suspectedTraps: k.suspectedTraps, end: k.forward.end, notReached: k.forward.notReached, order: k.forward.stops.map((s: any, i: number) => `${i + 1}. ${s.role} "${s.name.slice(0, 40)}" @${s.x},${s.y}`) }; };
  const frames = inv.childFrames.length ? { childFrames: inv.childFrames.map((f: any) => ({ url: f.url, title: f.title, images: f.images.length, links: f.links.length, fields: f.fields.length, tables: f.tables.length, media: f.media.length })) } : {};
  const by: Record<number, () => any> = {
    1: () => ({ images: inv.images.map((i: any) => ({ ...i, alt: i.alt === null ? '(no alt attribute)' : i.alt === '' ? '(empty alt)' : i.alt })) }),
    2: () => ({ frames: inv.frames.map((f: any) => ({ ...f, title: f.title === null ? '(no title attribute)' : f.title || '(empty title)' })) }),
    3: () => ({ note: 'Look at the screenshot.' }),
    4: () => ({ media: inv.media, frames: inv.frames, graphics: inv.images.filter((i: any) => ['object', 'embed', 'canvas', 'svg'].includes(i.tag)).slice(0, 15) }),
    5: () => ({ tables: inv.tables }),
    6: () => ({ links: [...new Map(inv.links.map((l: any) => [`${l.name}|${l.href}`, l])).values()] }),
    7: () => ({ buttons: inv.buttons, clickableNotFocusable: inv.clickableNotFocusable, live: inv.live, keyboard: kb() }),
    8: () => ({ lang: inv.lang, dir: inv.dir, title: inv.title, doctype: inv.doctype, duplicateIds: inv.duplicateIds, langChanges: inv.langChanges, dirChanges: inv.dirChanges, presentational: inv.presentational, text: inv.text }),
    9: () => ({ headings: inv.headings, landmarks: inv.landmarks, lists: inv.lists, quotes: inv.quotes, text: inv.text?.slice(0, 2500) }),
    10: () => { const f = get('focus'), r = get('reflow'), n = get('nocss'); return { presentational: inv.presentational, nocss: n && { generatedContent: n.generatedContent, backgroundImages: n.backgroundImages, textLost: n.textLost, readingOrder: n.readingOrder?.slice(0, 1500) }, text200: get('text200'), focus: f && { measured: f.measured, noVisibleChange: f.noVisibleChange, lowContrast: f.lowContrast, offscreen: f.offscreen }, reflow: r && { horizontalScroll: r.horizontalScroll, scrollWidth: r.scrollWidth, wide: r.wide?.slice(0, 10), clipped: r.clipped }, spacing: get('spacing') }; },
    11: () => ({ fields: inv.fields, buttons: inv.buttons, forms: a.evidence.filter((e) => e.page === page && e.kind === 'forms').map((e) => { const d = JSON.parse(store.readEvidence(a, e)); return { evidence: e.id, form: d.form, mode: d.mode, skipped: d.skipped, newText: d.newText, focusAfter: d.focusAfter?.path, nativeBubble: d.nativeBubble, limits: d.limits, fieldsAfter: d.fieldsAfter?.map((x: any) => ({ path: x.path, name: x.name, valid: x.valid, msg: x.validationMessage, ariaInvalid: x.ariaInvalid, describedby: x.describedby, required: x.required })) }; }) }),
    12: () => ({ skipLinks: inv.skipLinks, landmarks: inv.landmarks, keyboard: kb(), positiveTabindex: inv.positiveTabindex, accesskeys: inv.accesskeys, otherPages: a.pages.filter((p) => p.id !== page && p.collected).map((p) => ({ page: p.id, name: p.name, inventory: latest(a, p.id, 'inventory')?.id, screenshot: latest(a, p.id, 'screenshot')?.id })) }),
    13: () => ({ metaRefresh: inv.metaRefresh, newWindows: inv.links.filter((l: any) => l.target && l.target !== '_self'), documents: inv.documents, runningAnimations: inv.runningAnimations, events: inv.events }),
  };
  return drop({ ...(by[theme]?.() ?? {}), axeHints: axe.map((r: any) => ({ rule: r.rule, kind: r.kind, for: r.criteria, count: r.count, nodes: r.nodes.slice(0, 8) })), ...frames });
}

export function evidenceIndex(a: Audit, page: string): string {
  return a.evidence.filter((e) => e.page === page).map((e) => `${e.id} ${e.kind}${e.image ? ' (picture)' : ''}: ${e.label}${e.partial ? ` [PARTIAL: ${e.partial}]` : ''}`).join('\n');
}

export function openCriteria(a: Audit, pack: Pack, page: string): Criterion[] {
  return pack.criteria.filter((c) => pageStatus(a, c, page) === 'OPEN' && c.tests.some((t) => !a.verdicts[page]?.[t.id]));
}

function official(c: Criterion, testIds: string[], brief: boolean): string {
  const out = [`## ${c.id} ${c.title}`];
  for (const t of c.tests) if (testIds.includes(t.id)) out.push(`### Test ${t.id}\n${t.text}${brief ? '' : `\nMethod:\n${t.method}`}`);
  if (!brief && c.particularCases) out.push(`Special cases: ${c.particularCases}`);
  if (!brief && c.technicalNote) out.push(`Technical note: ${c.technicalNote}`);
  const needs = needsFor(c.id);
  if (needs.length) out.push(`A C must cite: ${needs.join(' + ')}.`);
  if (NO_INSTRUMENT[c.id]) out.push(`A C is impossible in this version (no ${NO_INSTRUMENT[c.id]}): use NC, NA, or BLOCKED.`);
  return out.join('\n');
}

const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n)}\n…[cut: ${s.length - n} more characters, read them with evidence_get]`;

export function nextTasks(store: Store, a: Audit, pack: Pack, page: string, limit: number, brief: boolean, only?: string): { rules: string; data: string; criteria: string[] } | null {
  let open = openCriteria(a, pack, page);
  if (only) open = open.filter((c) => c.id === only || String(c.theme) === only);
  if (!open.length) return null;
  const theme = open[0].theme;
  const chosen: string[] = [];
  let rules = `# Page ${page}, theme ${theme} (${open[0].themeName}). ${open.length} criteria left on this page.\n`;
  for (const c of open.filter((x) => x.theme === theme).slice(0, limit)) {
    const part = official(c, c.tests.filter((t) => !a.verdicts[page]?.[t.id]).map((t) => t.id), brief);
    if (chosen.length && rules.length + part.length > 22_000) break;
    rules += `\n${part}\n`;
    chosen.push(c.id);
  }
  return { rules, data: `Evidence on this page:\n${evidenceIndex(a, page)}\n\nFacts:\n${clip(JSON.stringify(facts(store, a, page, theme)), 16_000)}`, criteria: chosen };
}

/** Second look: the claim and the evidence, without the first verdict's reasoning. */
export function nextChecks(a: Audit, pack: Pack, limit: number): string | null {
  const out: string[] = [];
  for (const p of a.pages) for (const v of Object.values(a.verdicts[p.id] ?? {})) {
    if (v.verdict !== 'NC' || v.confidence !== 'unmeasured' || v.check || out.length >= limit) continue;
    const c = pack.byId.get(criterionOf(v.test))!;
    out.push(`# ${p.id} ${v.test}: claimed NC on ${v.elements?.join(' ; ')}\nEvidence: ${v.evidence.join(', ')}\n${official(c, [v.test], false)}`);
  }
  return out.length ? out.join('\n\n') : null;
}
