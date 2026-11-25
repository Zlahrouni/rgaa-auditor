// SPDX-License-Identifier: AGPL-3.0-or-later
// Functions that run INSIDE the audited page. They read; only the resize helpers change styles, on throwaway pages.
/* eslint-disable */

export interface Lib {
  path(el: Element): string; visible(el: Element): boolean; name(el: Element): string; role(el: Element): string;
  all(sel: string): Element[]; active(): Element | null; info(el: Element): any; texts(): { path: string; text: string }[];
  inventory(): any; tabbables(): string[]; clipped(): string[]; overlaps(): string[]; enlarge(): void; noCss(): any;
  forms(): any[]; fieldState(): any[]; live(): any[]; wide(limit: number): any[];
}

export function installLib(): void {
  const g = globalThis as any;
  if (g.__rgaa) return;
  const all = (sel: string, root: any = document): Element[] => {
    const out: Element[] = [];
    const walk = (r: any) => {
      for (const e of r.querySelectorAll('*')) {
        if (e.matches(sel)) out.push(e);
        if (e.shadowRoot) walk(e.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const path = (el: Element): string => {
    const parts: string[] = [];
    let e: any = el, sep = '';
    while (e && e.nodeType === 1) {
      let p = e.localName;
      const root = e.getRootNode();
      const ok = e.id && /^[A-Za-z][\w-]*$/.test(e.id) && root.querySelectorAll('#' + e.id).length === 1;
      if (ok) p = '#' + e.id;
      else if (e.parentNode && e.parentNode.children && e.localName !== 'html' && e.localName !== 'body') {
        p += `:nth-child(${[...e.parentNode.children].indexOf(e) + 1})`;
      }
      parts.unshift(p + sep);
      if (ok && root === document) break;
      if (e.parentElement && !ok) { sep = ' > '; e = e.parentElement; }
      else if (root.host) { sep = ' '; e = root.host; } // open shadow root: descendant combinator
      else break;
    }
    return parts.join('');
  };
  const visible = (el: any): boolean => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: false, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const short = (s: any, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
  const byIds = (el: any, attr: string) => (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean)
    .map((i: string) => { const t = el.getRootNode().getElementById?.(i); return t ? short(t.textContent) : `[missing #${i}]`; });
  const name = (el: any): string => short(el.computedName ?? el.getAttribute('aria-label') ?? el.textContent);
  const role = (el: any): string => String(el.computedRole ?? el.getAttribute('role') ?? '');
  const active = (): Element | null => { let a: any = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return a; };
  const info = (el: any) => {
    const r = el.getBoundingClientRect();
    return { path: path(el), tag: el.localName, role: role(el), name: name(el), type: el.getAttribute('type') ?? undefined,
      tabindex: el.getAttribute('tabindex') ?? undefined,
      x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const textNodes = (): Text[] => {
    const out: Text[] = [];
    const walk = (n: any) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { if (c.nodeValue.trim() && c.parentElement && visible(c.parentElement)) out.push(c); }
        else if (c.nodeType === 1 && !/^(script|style|noscript|template)$/.test(c.localName)) { if (c.shadowRoot) walk(c.shadowRoot); walk(c); }
      }
    };
    if (document.body) walk(document.body);
    return out;
  };
  const texts = () => textNodes().map((t) => ({ path: path(t.parentElement!), text: short(t.nodeValue, 300) }));
  const box = (t: Text) => { const r = document.createRange(); r.selectNodeContents(t); return r.getBoundingClientRect(); };
  const FOCUS = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,iframe,audio[controls],video[controls],[contenteditable=""],[contenteditable=true],[tabindex]';
  const tabbables = (): string[] => {
    const radios = new Set<string>();
    return all(FOCUS).filter((e: any) => {
      if (e.disabled || e.tabIndex < 0 || !visible(e) || e.closest('[inert]') || e.matches('fieldset[disabled] *')) return false;
      if (e.matches('input[type=radio]') && e.name) { // one tab stop per group
        const k = (e.form ? path(e.form) : '') + '|' + e.name;
        const group = all('input[type=radio]').filter((x: any) => x.name === e.name && x.form === e.form) as any[];
        const checked = group.find((x) => x.checked);
        if (checked ? checked !== e : radios.has(k)) return false;
        radios.add(k);
      }
      return true;
    }).map(path);
  };
  const clipped = (): string[] => {
    const out = new Set<string>();
    for (const t of textNodes()) {
      const b = box(t);
      if (b.width < 2 || b.height < 2) continue;
      for (let a: any = t.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const s = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        const cx = /hidden|clip/.test(s.overflowX) && (b.right > r.right + 3 || b.left < r.left - 3);
        const cy = /hidden|clip/.test(s.overflowY) && (b.bottom > r.bottom + 3 || b.top < r.top - 3);
        if (cx || cy) { out.add(`${path(t.parentElement!)} :: ${short(t.nodeValue, 80)}`); break; }
        if (s.position === 'fixed') break;
      }
    }
    return [...out];
  };
  const overlaps = (): string[] => {
    const ns = textNodes().slice(0, 500).map((t) => ({ t, b: box(t) })).filter((x) => x.b.width > 2 && x.b.height > 2);
    const out = new Set<string>();
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i], c = ns[j];
      const w = Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left);
      const h = Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top);
      if (w > 4 && h > 6 && !a.t.parentElement!.contains(c.t) && !c.t.parentElement!.contains(a.t)) {
        out.add(`"${short(a.t.nodeValue, 50)}" / "${short(c.t.nodeValue, 50)}"`);
      }
    }
    return [...out];
  };
  const enlarge = () => {
    const els = [...new Set([...textNodes().map((t) => t.parentElement!), ...(all('input,textarea,select,button') as HTMLElement[])])];
    const sizes = els.map((e) => parseFloat(getComputedStyle(e).fontSize));
    els.forEach((e, i) => (e as HTMLElement).style.setProperty('font-size', `${sizes[i] * 2}px`, 'important'));
  };
  const noCss = () => {
    const pseudo: any[] = [], backgrounds: any[] = [];
    for (const e of all('body *')) {
      if (!visible(e)) continue;
      for (const p of ['::before', '::after']) {
        const c = getComputedStyle(e, p).content;
        if (c && !/^(none|normal|""|'')$/.test(c) && /[\p{L}\p{N}!*✓✗→]/u.test(c.replace(/counter\([^)]*\)|url\([^)]*\)/g, ''))) pseudo.push({ path: path(e), p, content: short(c, 80) });
      }
      const bg = getComputedStyle(e).backgroundImage;
      if (/url\(/.test(bg)) { const r = e.getBoundingClientRect(); backgrounds.push({ path: path(e), image: short(bg, 100), w: Math.round(r.width), h: Math.round(r.height), text: short(e.textContent, 60), name: name(e) }); }
    }
    for (const s of [...document.styleSheets] as any[]) s.disabled = true;
    document.adoptedStyleSheets = [];
    for (const e of all('[style]')) e.removeAttribute('style');
    return { generatedContent: pseudo, backgroundImages: backgrounds };
  };
  const labels = (e: any) => [...(e.labels ?? [])].map((l: any) => ({ text: short(l.textContent), visible: visible(l) }));
  const field = (e: any) => {
    const fs = e.closest('fieldset,[role=group],[role=radiogroup]');
    return { ...info(e), labels: labels(e), ariaLabel: e.getAttribute('aria-label') ?? undefined, labelledby: byIds(e, 'aria-labelledby'),
      describedby: byIds(e, 'aria-describedby'), errormessage: byIds(e, 'aria-errormessage'), title: e.getAttribute('title') ?? undefined, placeholder: e.getAttribute('placeholder') ?? undefined,
      required: !!e.required || undefined, ariaRequired: e.getAttribute('aria-required') ?? undefined, autocomplete: e.getAttribute('autocomplete') ?? undefined,
      ariaInvalid: e.getAttribute('aria-invalid') ?? undefined, pattern: e.getAttribute('pattern') ?? undefined, visible: visible(e),
      group: fs ? { tag: fs.localName, legend: short(fs.querySelector('legend')?.textContent ?? fs.getAttribute('aria-label') ?? byIds(fs, 'aria-labelledby').join(' ')) } : undefined,
      form: e.form ? path(e.form) : undefined };
  };
  const FIELDS = 'input:not([type=hidden]):not([type=submit]):not([type=reset]):not([type=button]):not([type=image]),select,textarea,[role=textbox],[role=combobox],[role=listbox],[role=checkbox],[role=radio],[role=switch],[role=slider],[role=spinbutton],[contenteditable=""],[contenteditable=true]';
  const fieldState = () => (all(FIELDS) as any[]).filter(visible).map((e) => ({ path: path(e), name: name(e), valid: e.validity ? e.validity.valid : undefined,
    validationMessage: e.validationMessage || undefined, ariaInvalid: e.getAttribute('aria-invalid') ?? undefined,
    describedby: byIds(e, 'aria-describedby'), errormessage: byIds(e, 'aria-errormessage'), labels: labels(e).map((l: any) => l.text), required: !!e.required, type: e.type }));
  const forms = () => (all('form') as any[]).map((f) => ({ path: path(f), method: (f.getAttribute('method') ?? 'get').toLowerCase(), novalidate: f.noValidate, visible: visible(f),
    fields: [...f.elements].filter((e: any) => e.matches(FIELDS) && visible(e)).map((e: any) => ({ path: path(e), type: e.type, tag: e.localName, required: !!e.required })),
    submit: [...f.elements].filter((e: any) => e.matches('button:not([type]),button[type=submit],input[type=submit],input[type=image]') && visible(e)).map((e: any) => ({ path: path(e), name: name(e) })) }));
  const live = () => (all('[role=alert],[role=status],[role=log],[role=progressbar],[role=alertdialog],[aria-live],output') as any[])
    .map((e) => ({ path: path(e), role: e.getAttribute('role') ?? undefined, live: e.getAttribute('aria-live') ?? undefined, text: short(e.textContent), visible: visible(e) }));
  const wide = (limit: number) => {
    const out: any[] = [];
    for (const e of all('body *')) {
      if (!visible(e)) continue;
      const r = e.getBoundingClientRect();
      if (r.right + scrollX <= limit + 1 && r.left + scrollX >= -1) continue;
      let inScroller = false;
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(a).overflowX) && a.getBoundingClientRect().right <= limit + 1) { inScroller = true; break; }
      if (!inScroller) out.push({ path: path(e), right: Math.round(r.right + scrollX), width: Math.round(r.width), text: short(e.textContent, 60) });
    }
    return out;
  };
  const inventory = () => {
    const dt = document.doctype;
    const list = (sel: string, f: (e: any) => any) => (all(sel) as any[]).map(f);
    const ids = new Map<string, number>();
    for (const e of [...document.querySelectorAll('[id]')]) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
    const clickables = (all('body *') as any[]).filter((e) => visible(e) && !(e.matches(FOCUS) && e.tabIndex >= 0) && !e.closest('a[href],button,label,summary,select,[tabindex]:not([tabindex^="-"])')
      && (e.hasAttribute('onclick') || (getComputedStyle(e).cursor === 'pointer' && getComputedStyle(e.parentElement ?? e).cursor !== 'pointer')));
    const anims = (document.getAnimations?.() ?? []).filter((a) => a.playState === 'running').map((a: any) => ({ target: a.effect?.target ? path(a.effect.target) : '?', iterations: String(a.effect?.getTiming?.().iterations), duration: a.effect?.getTiming?.().duration }));
    return {
      url: location.href, title: document.title, hasTitle: !!document.querySelector('head > title, title'), lang: document.documentElement.getAttribute('lang'), xmlLang: document.documentElement.getAttribute('xml:lang'), dir: document.documentElement.getAttribute('dir'),
      doctype: dt ? { name: dt.name, publicId: dt.publicId, systemId: dt.systemId } : null, compatMode: document.compatMode,
      viewportMeta: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
      metaRefresh: [...document.querySelectorAll('meta[http-equiv=refresh i]')].map((m) => m.getAttribute('content')),
      images: list('img,svg,canvas,object,embed,area,input[type=image],[role=img],picture > source:not(source)', (e) => ({ ...info(e), alt: e.hasAttribute('alt') ? e.getAttribute('alt') : null, ariaHidden: e.closest('[aria-hidden=true]') ? true : undefined,
        ariaLabel: e.getAttribute('aria-label') ?? undefined, labelledby: byIds(e, 'aria-labelledby'), describedby: byIds(e, 'aria-describedby'), title: e.getAttribute('title') ?? undefined, svgTitle: e.localName === 'svg' ? short(e.querySelector('title')?.textContent) || undefined : undefined,
        src: short(e.getAttribute('src') ?? e.getAttribute('data') ?? '', 100) || undefined, inLinkOrButton: e.closest('a[href],button') ? name(e.closest('a[href],button')) || '(no name)' : undefined,
        figcaption: e.closest('figure')?.querySelector('figcaption') ? short(e.closest('figure').querySelector('figcaption').textContent) : undefined, visible: visible(e) })),
      frames: list('iframe,frame', (e) => ({ ...info(e), title: e.getAttribute('title'), src: short(e.getAttribute('src'), 120), visible: visible(e) })),
      links: list('a[href],area[href],[role=link]', (e) => ({ path: path(e), text: short(e.textContent), name: name(e), title: e.getAttribute('title') ?? undefined, ariaLabel: e.getAttribute('aria-label') ?? undefined, href: short(e.getAttribute('href'), 120), target: e.getAttribute('target') ?? undefined, visible: visible(e),
        context: short(e.closest('li,p,td,th,dd')?.textContent, 120) })),
      buttons: list('button,input[type=submit],input[type=button],input[type=reset],input[type=image],[role=button],summary', (e) => ({ ...info(e), text: short(e.textContent || e.value), title: e.getAttribute('title') ?? undefined, expanded: e.getAttribute('aria-expanded') ?? undefined, pressed: e.getAttribute('aria-pressed') ?? undefined, visible: visible(e) })),
      fields: list(FIELDS, field), forms: forms(),
      headings: list('h1,h2,h3,h4,h5,h6,[role=heading]', (e) => ({ path: path(e), level: Number(e.getAttribute('aria-level') ?? e.localName[1]), text: short(e.textContent), visible: visible(e) })),
      landmarks: list('header,nav,main,footer,aside,search,section[aria-label],section[aria-labelledby],[role=banner],[role=navigation],[role=main],[role=contentinfo],[role=search],[role=complementary],[role=region]', (e) => ({ path: path(e), role: role(e), name: name(e) === short(e.textContent) ? '' : name(e) })),
      lists: list('ul,ol,dl,[role=list]', (e) => ({ path: path(e), tag: e.localName, children: [...new Set([...e.children].map((c: any) => c.localName))].join(','), items: e.children.length, visible: visible(e) })),
      quotes: list('q,blockquote', (e) => ({ path: path(e), text: short(e.textContent, 100) })),
      tables: list('table,[role=table],[role=grid],[role=treegrid]', (e) => ({ path: path(e), role: e.getAttribute('role') ?? undefined, caption: short(e.querySelector('caption')?.textContent) || undefined, summary: e.getAttribute('summary') ?? undefined, ariaLabel: e.getAttribute('aria-label') ?? undefined, labelledby: byIds(e, 'aria-labelledby'), describedby: byIds(e, 'aria-describedby'), rows: e.rows?.length, th: [...e.querySelectorAll('th')].map((t: any) => ({ text: short(t.textContent, 40), scope: t.getAttribute('scope') ?? undefined, id: t.id || undefined, colspan: t.getAttribute('colspan') ?? undefined, rowspan: t.getAttribute('rowspan') ?? undefined })).slice(0, 40), tdHeaders: e.querySelectorAll('td[headers]').length, firstRow: short(e.rows?.[0]?.textContent, 120) })),
      media: list('audio,video,bgsound', (e) => ({ path: path(e), tag: e.localName, controls: e.controls, autoplay: e.autoplay, muted: e.muted, loop: e.loop, tracks: [...e.querySelectorAll('track')].map((t: any) => `${t.kind}:${t.srclang}`), duration: e.duration, visible: visible(e) })),
      langChanges: list('body [lang]', (e) => ({ path: path(e), lang: e.getAttribute('lang'), text: short(e.textContent, 80) })),
      dirChanges: list('body [dir]', (e) => ({ path: path(e), dir: e.getAttribute('dir'), text: short(e.textContent, 60) })),
      duplicateIds: [...ids].filter(([, n]) => n > 1).map(([i, n]) => `${i} x${n}`),
      positiveTabindex: list('[tabindex]', (e) => e).filter((e: any) => e.tabIndex > 0).map(path),
      clickableNotFocusable: clickables.map(info).slice(0, 60),
      presentational: list('center,font,basefont,big,blink,marquee,s,strike,tt,u,[align],[bgcolor],[background],[cellspacing],[valign],[hspace],[vspace],[border]:not(img)', (e) => `${e.localName} ${path(e)}`).slice(0, 40),
      runningAnimations: anims.slice(0, 30), live: live(), accesskeys: list('[accesskey]', (e) => `${path(e)}=${e.getAttribute('accesskey')}`),
      documents: list('a[href]', (e) => e).filter((e: any) => /\.(pdf|docx?|odt|xlsx?|ods|pptx?|odp|rtf|epub)([?#]|$)/i.test(e.getAttribute('href'))).map((e: any) => ({ path: path(e), href: short(e.getAttribute('href'), 120), name: name(e) })),
      skipLinks: list('a[href^="#"]', (e) => ({ path: path(e), text: short(e.textContent), href: e.getAttribute('href'), target: e.getAttribute('href') === '#' ? false : !!document.getElementById(e.getAttribute('href').slice(1)) })).slice(0, 20),
      shadowRoots: (all('*') as any[]).filter((e) => e.shadowRoot).length,
      text: short(document.body?.innerText, 6000),
    };
  };
  Object.defineProperty(g, '__rgaa', { value: { path, visible, name, role, all, active, info, texts, inventory, tabbables, clipped, overlaps, enlarge, noCss, forms, fieldState, live, wide }, enumerable: false });
}
