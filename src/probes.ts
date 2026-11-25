// SPDX-License-Identifier: AGPL-3.0-or-later
// Deterministic measurements. Probes report facts; they never decide conformity.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ElementHandle, Frame, Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { settle, type GuardedBrowser, type Opened } from './browser.ts';
import { dangerous, originAllowed } from './guard.ts';
import type { Lib } from './pagelib.ts';

declare const __rgaa: Lib;
export interface Result { data: any; image?: Buffer }

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
/** Hints only: which RGAA criteria an axe rule may concern. */
export const AXE_RGAA: Record<string, string[]> = {
  'image-alt': ['1.1'], 'input-image-alt': ['1.1'], 'area-alt': ['1.1'], 'svg-img-alt': ['1.1'], 'role-img-alt': ['1.1'], 'object-alt': ['1.1'], 'image-redundant-alt': ['1.3'],
  'frame-title': ['2.1'], 'frame-title-unique': ['2.2'], 'link-in-text-block': ['3.1', '10.6'], 'color-contrast': ['3.2'],
  'video-caption': ['4.3'], 'no-autoplay-audio': ['4.10'], 'td-headers-attr': ['5.7'], 'th-has-data-cells': ['5.7'], 'scope-attr-valid': ['5.7'], 'td-has-header': ['5.6'], 'empty-table-header': ['5.6'],
  'link-name': ['6.2'], 'label-content-name-mismatch': ['6.1', '7.1', '11.2', '11.9'], 'button-name': ['7.1', '11.9'], 'input-button-name': ['11.9'],
  'html-has-lang': ['8.3'], 'html-lang-valid': ['8.4'], 'html-xml-lang-mismatch': ['8.4'], 'valid-lang': ['8.8'], 'document-title': ['8.5'], 'duplicate-id-aria': ['8.2'],
  'heading-order': ['9.1'], 'empty-heading': ['9.1'], 'page-has-heading-one': ['9.1'], 'list': ['9.3'], 'listitem': ['9.3'], 'definition-list': ['9.3'], 'dlitem': ['9.3'], 'region': ['9.2'],
  'landmark-one-main': ['9.2'], 'landmark-no-duplicate-main': ['9.2'], 'landmark-unique': ['9.2'], 'aria-hidden-focus': ['10.8'], 'aria-hidden-body': ['10.8'], 'meta-viewport': ['10.4'],
  'label': ['11.1'], 'select-name': ['11.1'], 'aria-input-field-name': ['11.1'], 'form-field-multiple-labels': ['11.1'], 'label-title-only': ['11.1'], 'autocomplete-valid': ['11.13'],
  'bypass': ['12.7'], 'skip-link': ['12.7'], 'tabindex': ['12.8'], 'accesskeys': ['12.10'], 'scrollable-region-focusable': ['7.3'], 'nested-interactive': ['7.1'],
  'meta-refresh': ['13.1'], 'blink': ['13.8'], 'marquee': ['13.8'], 'css-orientation-lock': ['13.9'],
};
const axeCriteria = (rule: string) => AXE_RGAA[rule] ?? (rule.startsWith('aria-') ? ['7.1'] : []);

export async function axe(page: Page): Promise<Result> {
  const out: any[] = [], errors: string[] = [];
  for (const f of page.frames()) {
    try {
      await f.evaluate(AXE);
      const r: any = await f.evaluate(() => (globalThis as any).axe.run(document, { iframes: false, resultTypes: ['violations', 'incomplete'] }));
      for (const [kind, list] of [['violation', r.violations], ['needs review', r.incomplete]] as const) for (const v of list) {
        out.push({ rule: v.id, kind, criteria: axeCriteria(v.id), help: v.help, frame: f === page.mainFrame() ? undefined : f.url(), count: v.nodes.length,
          nodes: v.nodes.slice(0, 25).map((n: any) => ({ target: n.target.flat().join(' '), html: n.html.slice(0, 200), why: (n.failureSummary ?? n.any?.[0]?.message ?? '').replace(/\s+/g, ' ').slice(0, 260) })) });
      }
    } catch (e) { errors.push(`${f.url().slice(0, 120)}: ${(e as Error).message.split('\n')[0]}`); }
  }
  return { data: { results: out, errors } };
}

export async function inventory(o: Opened): Promise<Result> {
  const main = await o.page.evaluate(() => __rgaa.inventory());
  const frames: any[] = [];
  let unreadable = 0;
  for (const f of o.page.frames()) if (f !== o.page.mainFrame()) {
    try { frames.push(await f.evaluate(() => __rgaa.inventory())); } catch { unreadable++; }
  }
  const aria = await o.page.locator('body').ariaSnapshot({ timeout: 8000 }).catch(() => '');
  return { data: { ...main, status: o.response?.status, rawStart: o.response?.html.slice(0, 300), childFrames: frames, unreadableFrames: unreadable, ariaSnapshot: aria.slice(0, 30_000), blocked: o.blocked, events: o.events } };
}

export async function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', timeout: 20_000, clip: undefined })
    .catch(() => page.screenshot({ timeout: 20_000 }));
}

/** Puts small pictures side by side with a number, so one image is enough for the AI. */
export async function sheet(b: GuardedBrowser, items: { label: string; png: Buffer }[], width = 1000): Promise<Buffer> {
  const ctx = await (await b.raw()).newContext({ viewport: { width, height: 400 }, offline: true, javaScriptEnabled: false });
  try {
    const p = await ctx.newPage();
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    await p.setContent(`<body style="margin:8px;font:13px sans-serif;display:flex;flex-wrap:wrap;gap:10px;background:#fff">${items.map((i) =>
      `<div style="border:1px solid #888;padding:4px;max-width:320px"><div>${esc(i.label)}</div><img style="max-width:310px;max-height:240px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0/12px 12px" src="data:image/png;base64,${i.png.toString('base64')}"></div>`).join('')}</body>`);
    return await p.screenshot({ fullPage: true });
  } finally { await ctx.close(); }
}

export async function images(b: GuardedBrowser, o: Opened, inv: any): Promise<Result | null> {
  const list = inv.images.filter((i: any) => i.visible && i.w >= 4 && i.h >= 4);
  if (!list.length) return null;
  const shown: any[] = [], items: { label: string; png: Buffer }[] = [];
  for (const [n, i] of list.slice(0, 24).entries()) {
    try {
      const png = await o.page.locator(i.path).first().screenshot({ timeout: 3000, animations: 'disabled' });
      items.push({ label: `#${n + 1}`, png });
      shown.push({ n: n + 1, ...i });
    } catch { shown.push({ n: n + 1, ...i, picture: 'not available' }); }
  }
  return { data: { total: list.length, shown: shown.length, images: shown }, image: items.length ? await sheet(b, items) : undefined };
}

/** The focused element, followed into iframes and open shadow roots. */
async function focused(scope: Page | Frame, ox = 0, oy = 0, prefix = ''): Promise<{ info: any; handle: ElementHandle<Element> } | null> {
  const el = (await scope.evaluateHandle(() => { const a = __rgaa.active(); return !a || a === document.body || a === document.documentElement ? null : a; })).asElement() as ElementHandle<Element> | null;
  if (!el) return null;
  const info: any = await el.evaluate((a) => {
    const r = a.getBoundingClientRect(), c = getComputedStyle(a);
    return { ...__rgaa.info(a), vx: r.x, vy: r.y, outline: `${c.outlineStyle} ${c.outlineWidth}`, shadow: c.boxShadow === 'none' ? undefined : c.boxShadow.slice(0, 80), bl: c.borderLeftWidth, bt: c.borderTopWidth, vw: innerWidth, vh: innerHeight };
  });
  info.vx += ox; info.vy += oy; info.x += ox; info.y += oy;
  if (info.tag === 'iframe' || info.tag === 'frame') {
    const inner = await el.contentFrame();
    const deep = inner ? await focused(inner, info.vx + parseFloat(info.bl), info.vy + parseFloat(info.bt), `${prefix}${info.path} => `).catch(() => null) : null;
    if (deep) return deep;
  }
  info.host = prefix.split(' => ')[0] || undefined;
  info.path = prefix + info.path;
  return { info, handle: el };
}
const slim = ({ vx, vy, bl, bt, vw, vh, outline, shadow, ...s }: any) => s;

export async function keyboard(b: GuardedBrowser, url: string, limit = 150): Promise<Result> {
  const walk = async (key: string) => {
    const o = await b.open(url);
    try {
      const expected = await o.page.evaluate(() => __rgaa.tabbables());
      const stops: any[] = [];
      let end = 'limit reached', same = 0, escape: string | undefined;
      const seen = new Map<string, number>();
      for (let i = 0; i < limit; i++) {
        await o.page.keyboard.press(key);
        const f = await focused(o.page);
        const s = f && slim(f.info);
        if (!s) { end = 'focus left the page content'; break; }
        const prev = stops.at(-1);
        same = prev?.path === s.path ? same + 1 : 0;
        if (same === 0) {
          const before = seen.get(s.path);
          if (before !== undefined) {
            end = before === 0 ? 'came back to the first element' : `loop: came back to stop ${before + 1} without reaching the end`;
            if (before > 0) {
              await o.page.keyboard.press('Escape');
              await o.page.keyboard.press(key);
              escape = await o.page.evaluate(() => { const a = __rgaa.active(); return a && a !== document.body ? __rgaa.path(a) : 'page body'; });
            }
            break;
          }
          seen.set(s.path, stops.length);
          stops.push(s);
        } else if (same > 12) {
          await o.page.keyboard.press('Escape');
          await o.page.keyboard.press(key);
          escape = await o.page.evaluate(() => { const a = __rgaa.active(); return a && a !== document.body ? __rgaa.path(a) : 'page body'; });
          end = `stuck: focus stayed on ${s.path} for ${same} presses`;
          break;
        }
      }
      const got = new Set(stops.flatMap((s) => [s.path, s.host]));
      return { key, end, afterEscape: escape, stops, expected: expected.length, notReached: expected.filter((e) => !got.has(e)), blocked: o.blocked, events: o.events, opened: o };
    } catch (e) { await o.close(); throw e; }
  };
  const fwd = await walk('Tab');
  let image: Buffer | undefined;
  try {
    await fwd.opened.page.evaluate((stops) => {
      scrollTo(0, 0);
      for (const [i, s] of stops.entries()) {
        const d = document.createElement('div');
        d.textContent = String(i + 1);
        d.style.cssText = `position:absolute;z-index:2147483647;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;outline:2px solid #d00;color:#fff;font:bold 12px sans-serif;pointer-events:none;text-shadow:0 0 3px #000,0 0 3px #d00;box-sizing:border-box`;
        document.body.append(d);
      }
    }, fwd.stops);
    image = await screenshot(fwd.opened.page);
  } catch { /* picture is optional */ } finally { await fwd.opened.close(); }
  const back = await walk('Shift+Tab');
  await back.opened.close();
  const trap = [fwd, back].filter((w) => /^(loop|stuck)/.test(w.end)).map((w) => `${w.key}: ${w.end}${w.afterEscape ? `; after Escape the focus went to ${w.afterEscape}` : ''}`);
  const clean = ({ opened, ...w }: any) => w;
  return { data: { suspectedTraps: trap, forward: clean(fwd), backward: clean(back), note: 'A loop inside an open modal dialog, or arrow-key widgets, may be legitimate.' }, image };
}

const lum = (r: number, g: number, b: number) => { const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export function diff(a: Buffer, b: Buffer): { changed: number; share: number; contrast: number } {
  const A = PNG.sync.read(a), B = PNG.sync.read(b);
  const n = Math.min(A.data.length, B.data.length) / 4;
  const ratios: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const d = Math.abs(A.data[k] - B.data[k]) + Math.abs(A.data[k + 1] - B.data[k + 1]) + Math.abs(A.data[k + 2] - B.data[k + 2]);
    if (d < 24) continue;
    const x = lum(A.data[k], A.data[k + 1], A.data[k + 2]), y = lum(B.data[k], B.data[k + 1], B.data[k + 2]);
    ratios.push((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05));
  }
  ratios.sort((p, q) => p - q);
  return { changed: ratios.length, share: n ? ratios.length / n : 0, contrast: ratios.length ? Math.round(ratios[Math.floor(ratios.length * 0.9)] * 100) / 100 : 1 };
}

export async function focus(b: GuardedBrowser, url: string, limit = 40): Promise<Result> {
  const o = await b.open(url);
  const items: any[] = [], pics: { label: string; png: Buffer }[] = [];
  let end = 'limit reached';
  try {
    const seen = new Set<string>();
    for (let i = 0; i < limit * 2 && items.length < limit; i++) {
      await o.page.keyboard.press('Tab');
      await o.page.waitForTimeout(220); // let focus transitions finish
      const f = await focused(o.page);
      const s = f?.info;
      if (!f) { end = 'all elements measured'; break; }
      if (seen.has(s.path)) { if (seen.size > 1) { end = 'came back to a known element'; break; } else continue; }
      seen.add(s.path);
      const x = Math.max(0, s.vx - 8), y = Math.max(0, s.vy - 8);
      const clip = { x, y, width: Math.min(s.vw, s.vx + s.w + 8) - x, height: Math.min(s.vh, s.vy + s.h + 8) - y };
      const rec: any = { path: s.path, role: s.role, name: s.name, outline: s.outline, shadow: s.shadow };
      if (clip.width < 3 || clip.height < 3) { rec.offscreen = true; items.push(rec); continue; }
      const on = await o.page.screenshot({ clip, caret: 'hide', animations: 'disabled' });
      await f.handle.evaluate((e: any) => e.blur());
      await o.page.waitForTimeout(220);
      const off = await o.page.screenshot({ clip, caret: 'hide', animations: 'disabled' });
      const d = diff(on, off);
      rec.changedPixels = d.changed; rec.contrastOfChange = d.contrast; rec.visibleChange = d.changed >= 12;
      items.push(rec);
      if ((!rec.visibleChange || d.contrast < 3) && pics.length < 16) pics.push({ label: `${s.path.slice(-34)} focused`, png: on }, { label: 'not focused', png: off });
    }
  } finally { await o.close(); }
  return { data: { end, measured: items.length, noVisibleChange: items.filter((i) => i.visibleChange === false).map((i) => i.path), lowContrast: items.filter((i) => i.visibleChange && i.contrastOfChange < 3).map((i) => `${i.path} (${i.contrastOfChange}:1)`), offscreen: items.filter((i) => i.offscreen).map((i) => i.path), items },
    image: pics.length ? await sheet(b, pics) : undefined };
}

export async function reflow(b: GuardedBrowser, url: string): Promise<Result> {
  const o = await b.open(url, { width: 320, height: 800 });
  try {
    const r = await o.page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, wide: __rgaa.wide(document.documentElement.clientWidth).slice(0, 25), clipped: __rgaa.clipped().slice(0, 25) }));
    return { data: { horizontalScroll: r.scrollWidth > r.clientWidth + 1, ...r, note: 'Images, tables, maps and tool bars may be exempt: see the special cases.' }, image: await screenshot(o.page) };
  } finally { await o.close(); }
}

async function stress(b: GuardedBrowser, url: string, apply: (p: Page) => Promise<unknown>): Promise<Result> {
  const o = await b.open(url);
  try {
    const read = () => o.page.evaluate(() => ({ clipped: __rgaa.clipped(), overlaps: __rgaa.overlaps() }));
    const before = await read();
    await apply(o.page);
    await o.page.waitForTimeout(300);
    const after = await read();
    const fresh = (x: string[], y: string[]) => x.filter((v) => !y.includes(v)).slice(0, 30);
    return { data: { newlyClipped: fresh(after.clipped, before.clipped), newOverlaps: fresh(after.overlaps, before.overlaps), clippedBefore: before.clipped.length }, image: await screenshot(o.page) };
  } finally { await o.close(); }
}
export const text200 = (b: GuardedBrowser, url: string) => stress(b, url, (p) => p.evaluate(() => __rgaa.enlarge()));
export const spacing = (b: GuardedBrowser, url: string) => stress(b, url, (p) => p.evaluate(() => {
  const s = document.createElement('style');
  s.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}';
  document.head.append(s);
}));

export async function nocss(b: GuardedBrowser, url: string): Promise<Result> {
  const o = await b.open(url);
  try {
    const before = (await o.page.evaluate(() => __rgaa.texts())).map((t) => t.text);
    const facts = await o.page.evaluate(() => __rgaa.noCss());
    await o.page.waitForTimeout(200);
    const after = (await o.page.evaluate(() => __rgaa.texts())).map((t) => t.text);
    return { data: { ...facts, textLost: before.filter((t) => !after.includes(t)).slice(0, 30), textAppeared: after.filter((t) => !before.includes(t)).slice(0, 30), readingOrder: after.join(' | ').slice(0, 5000) }, image: await screenshot(o.page) };
  } finally { await o.close(); }
}

const BAD: Record<string, string> = { email: 'abc', tel: 'xx', url: 'abc', number: '', date: '', text: 'x', search: 'x', password: 'x' };
export async function formErrors(b: GuardedBrowser, url: string, mode: 'empty' | 'invalid', only?: string): Promise<Result[]> {
  const first = await b.open(url);
  const forms = (await first.page.evaluate(() => __rgaa.forms())).filter((f: any) => f.visible && f.submit.length && (!only || f.path === only));
  await first.close();
  const out: Result[] = [];
  for (const f of forms.slice(0, 5)) {
    const s = f.submit[0];
    if (!b.policy.sandbox && dangerous(s.name)) { out.push({ data: { form: f.path, skipped: `submit button "${s.name}" looks irreversible` } }); continue; }
    const o = await b.open(url);
    try {
      const before = await o.page.evaluate(() => __rgaa.texts());
      const initial = await o.page.evaluate(() => __rgaa.fieldState());
      const filled: string[] = [];
      if (mode === 'invalid') for (const x of f.fields) {
        const v = x.tag === 'textarea' ? 'x' : BAD[x.type];
        if (v) { await o.page.locator(x.path).first().fill(v, { timeout: 2000 }).then(() => filled.push(`${x.path} = "${v}"`)).catch(() => {}); }
      }
      await o.page.locator(s.path).first().click({ timeout: 4000 }).catch((e) => o.events.push(`click failed: ${e.message.split('\n')[0]}`));
      await o.page.waitForTimeout(900);
      const left = o.page.url() !== url;
      const state = await o.page.evaluate(() => ({ fields: __rgaa.fieldState(), live: __rgaa.live(), texts: __rgaa.texts(), title: document.title, focus: __rgaa.active() ? __rgaa.info(__rgaa.active()!) : null }));
      const known = new Set(before.map((t) => t.text));
      out.push({ data: { form: f.path, mode, submit: s, novalidate: f.novalidate, filled, newText: state.texts.filter((t) => !known.has(t.text)).slice(0, 40), focusAfter: state.focus, title: state.title, liveRegions: state.live, fieldsBefore: initial.slice(0, 60), fieldsAfter: state.fields.slice(0, 60),
        nativeBubble: !f.novalidate && state.fields.some((x: any) => x.valid === false), urlChanged: left ? o.page.url() : false, blocked: o.blocked, events: o.events,
        limits: o.blocked.length ? 'A submission was blocked, so messages produced by the server were NOT seen.' : undefined }, image: await screenshot(o.page) });
    } finally { await o.close(); }
  }
  return out;
}

export interface Step { action: 'press' | 'click' | 'hover' | 'fill' | 'select' | 'viewport' | 'wait'; selector?: string; value?: string }
export async function interact(b: GuardedBrowser, url: string, steps: Step[]): Promise<Result> {
  const o = await b.open(url);
  const log: any[] = [];
  try {
    for (const st of steps.slice(0, 15)) {
      const before = await o.page.evaluate(() => ({ t: __rgaa.texts().map((x) => x.text), live: JSON.stringify(__rgaa.live()) })).catch(() => ({ t: [] as string[], live: '' }));
      const nb = o.blocked.length, ne = o.events.length;
      let error: string | undefined, target: any;
      try {
        const loc = st.selector ? o.page.locator(st.selector).first() : null;
        if (loc) {
          target = await loc.evaluate((e) => ({ ...__rgaa.info(e), expanded: e.getAttribute('aria-expanded') }), undefined, { timeout: 3000 });
          if (st.action === 'click' && !b.policy.sandbox && dangerous(target.name)) throw new Error(`refused: "${target.name}" looks irreversible`);
        }
        if (st.action === 'press') {
          if (loc) await loc.focus({ timeout: 3000 });
          const act = await o.page.evaluate(() => { const a = __rgaa.active(); return a ? __rgaa.name(a) : ''; });
          if (/^(Enter|Space| )$/.test(st.value ?? '') && !b.policy.sandbox && dangerous(act) && act.length < 80) throw new Error(`refused: "${act}" looks irreversible`);
          await o.page.keyboard.press(st.value === ' ' ? 'Space' : st.value ?? 'Tab');
        } else if (st.action === 'viewport') {
          const [w, h] = (st.value ?? '').split('x').map(Number);
          if (!(w >= 200 && w <= 3000 && h >= 200 && h <= 3000)) throw new Error('viewport must be like 390x844');
          await o.page.setViewportSize({ width: w, height: h });
        } else if (st.action === 'wait') await o.page.waitForTimeout(Math.min(Number(st.value) || 500, 8000));
        else if (!loc) throw new Error('selector needed');
        else if (st.action === 'click') await loc.click({ timeout: 4000 });
        else if (st.action === 'hover') await loc.hover({ timeout: 4000 });
        else if (st.action === 'fill') await loc.fill(st.value ?? '', { timeout: 4000 });
        else if (st.action === 'select') await loc.selectOption(st.value ?? '', { timeout: 4000 });
        await settle(o.page);
      } catch (e) { error = (e as Error).message.split('\n')[0]; }
      const after = await o.page.evaluate(() => ({ t: __rgaa.texts(), live: __rgaa.live(), focus: __rgaa.active() ? __rgaa.info(__rgaa.active()!) : null, url: location.href, title: document.title })).catch(() => null);
      const was = new Set(before.t), now = new Set((after?.t ?? []).map((x) => x.text));
      const state = st.selector ? await o.page.locator(st.selector).first().evaluate((e) => ({ expanded: e.getAttribute('aria-expanded'), pressed: e.getAttribute('aria-pressed'), selected: e.getAttribute('aria-selected'), checked: e.getAttribute('aria-checked'), name: __rgaa.name(e) }), undefined, { timeout: 1000 }).catch(() => null) : null;
      log.push({ step: st, error, target, stateAfter: state, appeared: (after?.t ?? []).filter((x) => !was.has(x.text)).slice(0, 25), disappeared: before.t.filter((x) => !now.has(x)).slice(0, 25), focus: after?.focus, url: after?.url, title: after?.title,
        liveChanged: after && JSON.stringify(after.live) !== before.live ? after.live : undefined, blocked: o.blocked.slice(nb), events: o.events.slice(ne) });
      if (error) break;
      // Redirects are followed by the browser itself, so the arrival page is checked again here.
      if (!originAllowed(o.page.url(), b.policy)) { log.push({ stopped: `left the authorised origins: ${o.page.url().slice(0, 120)}` }); return { data: { url, log } }; }
    }
    return { data: { url, log }, image: await o.page.screenshot({ animations: 'disabled' }) };
  } finally { await o.close(); }
}

export async function element(b: GuardedBrowser, url: string, selector: string): Promise<Result> {
  const o = await b.open(url);
  try {
    const loc = o.page.locator(selector).first();
    const data = await loc.evaluate((e: any) => {
      const c = getComputedStyle(e);
      return { info: __rgaa.info(e), visible: __rgaa.visible(e), html: e.outerHTML.slice(0, 2500), parent: e.parentElement ? e.parentElement.cloneNode(false).outerHTML.slice(0, 300) : null,
        text: (e.innerText ?? '').slice(0, 800), style: { color: c.color, background: c.backgroundColor, font: `${c.fontSize} ${c.fontWeight}`, decoration: c.textDecorationLine, outline: c.outline, cursor: c.cursor, display: c.display, overflow: c.overflow } };
    }, undefined, { timeout: 4000 });
    const image = await loc.screenshot({ timeout: 4000, animations: 'disabled' }).catch(() => undefined);
    return { data, image };
  } finally { await o.close(); }
}
