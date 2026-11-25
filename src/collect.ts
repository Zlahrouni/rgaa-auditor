// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs every probe on a page, stores the evidence and records the few verdicts a direct measurement can decide.
import type { GuardedBrowser } from './browser.ts';
import type { Pack } from './pack.ts';
import { record, type Audit, type Confidence, type EvidenceKind, type NewVerdict } from './ledger.ts';
import type { Store } from './store.ts';
import * as probe from './probes.ts';

interface Item { kind: EvidenceKind; label: string; result: probe.Result }

/** Why a measurement does not cover the whole page. A partial measurement can prove NC, never C. */
export function partial(kind: EvidenceKind, d: any): string | undefined {
  if (kind === 'keyboard' && [d.forward.end, d.backward.end].includes('limit reached')) return 'the walk stopped at its limit';
  if (kind === 'focus' && d.end === 'limit reached') return 'only the first elements were measured';
  if (kind === 'images' && d.shown < d.total) return `${d.shown} of ${d.total} pictures shown`;
  if (kind === 'forms' && (d.skipped || d.limits)) return d.skipped ?? 'server messages were not seen';
  if (kind === 'axe' && d.errors.length) return 'some frames were not analysed';
  return undefined;
}

export async function gather(b: GuardedBrowser, url: string): Promise<{ items: Item[]; errors: string[]; inv: any }> {
  const items: Item[] = [], errors: string[] = [];
  const put = (kind: EvidenceKind, label: string, result: probe.Result | null) => { if (result) items.push({ kind, label, result }); };
  const safely = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { errors.push(`${name}: ${(e as Error).message.split('\n')[0]}`); } };

  const o = await b.open(url);
  let inv: any;
  try {
    const status = o.response?.status ?? 0;
    if (status >= 400) throw new Error(`HTTP ${status} on ${url}`);
    const r = await probe.inventory(o);
    inv = r.data;
    put('inventory', 'Page content', r);
    await safely('screenshot', async () => put('screenshot', 'Full page 1280 px', { data: { width: 1280 }, image: await probe.screenshot(o.page) }));
    await safely('images', async () => put('images', 'Pictures side by side', await probe.images(b, o, inv)));
    await safely('axe', async () => put('axe', 'axe-core results (hints)', await probe.axe(o.page)));
  } finally { await o.close(); }

  await safely('keyboard', async () => put('keyboard', 'Tab and Shift+Tab walk', await probe.keyboard(b, url)));
  await safely('focus', async () => put('focus', 'Focus indicator measurements', await probe.focus(b, url)));
  await Promise.all([
    safely('reflow', async () => put('reflow', '320 px wide window', await probe.reflow(b, url))),
    safely('text200', async () => put('text200', 'Text enlarged to 200%', await probe.text200(b, url))),
    safely('spacing', async () => put('spacing', 'Text spacing increased', await probe.spacing(b, url))),
    safely('nocss', async () => put('nocss', 'Style sheets off', await probe.nocss(b, url))),
  ]);
  if (inv.forms.some((f: any) => f.visible)) for (const mode of ['empty', 'invalid'] as const) {
    await safely(`forms ${mode}`, async () => { for (const r of await probe.formErrors(b, url, mode)) put('forms', `Form submitted ${mode}: ${r.data.form}`, r); });
  }
  return { items, errors, inv };
}

interface Auto extends Omit<NewVerdict, 'evidence'> { confidence: Confidence }

/** Verdicts decided without AI. Only facts that the inventory can establish on its own. */
export function autoVerdicts(inv: any, pack: Pack): Auto[] {
  const out: Auto[] = [];
  const docs = [inv, ...inv.childFrames];
  const sum = (k: string) => docs.reduce((n, d) => n + d[k].length, 0);
  const whole = inv.unreadableFrames === 0;
  const na = (criteria: string[], reason: string, confidence: Confidence = 'proven') => {
    for (const c of criteria) for (const t of pack.byId.get(c)?.tests ?? []) out.push({ test: t.id, verdict: 'NA', reason, confidence });
  };
  const range = (theme: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${theme}.${from + i}`);

  if (inv.frames.length === 0) na(['2.1', '2.2'], 'No iframe or frame element in the page as loaded.');
  else {
    const missing = inv.frames.filter((f: any) => f.visible && f.title === null);
    if (missing.length) out.push({ test: '2.1.1', verdict: 'NC', reason: `${missing.length} visible frame(s) without a title attribute.`, elements: missing.map((f: any) => f.path), impact: 'A screen reader user cannot know what the frame contains before entering it.', confidence: 'proven' });
    else if (inv.frames.every((f: any) => f.title !== null)) out.push({ test: '2.1.1', verdict: 'C', reason: 'Every frame has a title attribute.', confidence: 'proven' });
  }
  if (whole) {
    if (sum('images') === 0) na(range(1, 1, 9), 'No image, svg, canvas, object, embed, area, image button or role="img" in the page as loaded.');
    if (sum('tables') === 0) na(range(5, 1, 8), 'No table element and no table, grid or treegrid role in the page as loaded.');
    if (sum('links') === 0) na(['6.1', '6.2'], 'No link in the page as loaded.');
    if (sum('fields') === 0) {
      na([...range(11, 1, 8), ...range(11, 10, 13)], 'No form field in the page as loaded.');
      if (sum('buttons') === 0) na(['11.9'], 'No button in the page as loaded.');
    }
    const embeds = docs.flatMap((d) => d.images).filter((i: any) => ['object', 'embed', 'canvas', 'svg'].includes(i.tag)).length;
    // Scripts can create sound without any element, so this is not a proof.
    if (sum('media') === 0 && sum('frames') === 0 && embeds === 0) na([...range(4, 1, 9), ...range(4, 11, 13)], 'No audio, video, object, embed, canvas, svg or frame in the page as loaded.', 'unmeasured');
  }
  const d = inv.doctype;
  if (!d) {
    out.push({ test: '8.1.1', verdict: 'NC', reason: 'The page has no doctype.', elements: ['html'], impact: 'Browsers and assistive technologies may interpret the page unpredictably.', confidence: 'proven' });
  } else {
    out.push({ test: '8.1.1', verdict: 'C', reason: 'A doctype is present.', confidence: 'proven' });
    if (d.name === 'html' && !d.publicId && (!d.systemId || d.systemId === 'about:legacy-compat')) out.push({ test: '8.1.2', verdict: 'C', reason: 'HTML5 doctype.', confidence: 'proven' });
    if (/^﻿?\s*(<!--[\s\S]*?-->\s*)*<!doctype/i.test(inv.rawStart ?? '')) out.push({ test: '8.1.3', verdict: 'C', reason: 'The doctype comes before the html tag in the source.', confidence: 'proven' });
  }
  if ((inv.lang ?? '').trim() || (inv.xmlLang ?? '').trim()) out.push({ test: '8.3.1', verdict: 'C', reason: `Language on html: "${inv.lang ?? inv.xmlLang}".`, confidence: 'proven' });
  if (!inv.hasTitle) out.push({ test: '8.5.1', verdict: 'NC', reason: 'The page has no title element.', elements: ['head'], impact: 'A person cannot identify the page among tabs or with a screen reader.', confidence: 'proven' });
  else if (inv.title.trim()) out.push({ test: '8.5.1', verdict: 'C', reason: `Title present: "${inv.title}".`, confidence: 'proven' });
  if (inv.duplicateIds.length) out.push({ test: '8.2.1', verdict: 'NC', reason: `Duplicate id values: ${inv.duplicateIds.slice(0, 10).join(', ')}.`, elements: inv.duplicateIds.slice(0, 10).map((x: string) => `[id="${x.replace(/ x\d+$/, '')}"]`), impact: 'Labels and ARIA references may point to the wrong element.', confidence: 'proven' });
  return out;
}

export async function collect(store: Store, b: GuardedBrowser, pack: Pack, auditId: string, pageId: string) {
  const url = store.load(auditId).pages.find((p) => p.id === pageId)?.url;
  if (!url) throw new Error(`unknown page ${pageId}`);
  const g = await gather(b, url);
  // Reload after the slow part, so verdicts recorded meanwhile are kept.
  const audit: Audit = store.load(auditId);
  const page = audit.pages.find((p) => p.id === pageId)!;
  const ids: Record<string, string[]> = {};
  for (const i of g.items) (ids[i.kind] ??= []).push(store.addEvidence(audit, pageId, i.kind, i.label, i.result.data, i.result.image, partial(i.kind, i.result.data)).id);
  page.collected = true;
  page.title = g.inv.title;
  page.notes = [...g.errors.map((e) => `probe failed: ${e}`), ...g.inv.blocked.map((x: string) => `blocked: ${x}`)].slice(0, 30);
  const invId = ids.inventory[0];
  const auto = autoVerdicts(g.inv, pack);
  for (const { confidence, ...v } of auto) {
    const old = audit.verdicts[pageId]?.[v.test];
    if (old?.confidence !== 'confirmed') record(audit, pageId, { ...v, evidence: [invId] }, confidence, 'engine');
  }
  store.save(audit);
  return { page, ids, errors: g.errors, auto: auto.length };
}
