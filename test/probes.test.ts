// SPDX-License-Identifier: AGPL-3.0-or-later
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuardedBrowser } from '../src/browser.ts';
import { autoVerdicts, collect } from '../src/collect.ts';
import type { Audit } from '../src/ledger.ts';
import { Store } from '../src/store.ts';
import { nextTasks } from '../src/tasks.ts';
import { policyFromEnv } from '../src/guard.ts';
import { loadPack } from '../src/pack.ts';
import * as probe from '../src/probes.ts';
import { GOOD, startSite, type Site } from './site.ts';

const pack = loadPack();
let site: Site, b: GuardedBrowser;
before(async () => { site = await startSite(); b = new GuardedBrowser(policyFromEnv({})); });
after(async () => { await b.close(); await site.close(); });
const inv = async (p: string) => { const o = await b.open(site.base + p); try { return (await probe.inventory(o)).data; } finally { await o.close(); } };
const auto = async (p: string) => new Map(autoVerdicts(await inv(p), pack).map((v) => [v.test, v]));

test('good page: nothing is reported by the probes', async () => {
  const u = site.base + '/good';
  const [f, r, t, s, k] = [await probe.focus(b, u), await probe.reflow(b, u), await probe.text200(b, u), await probe.spacing(b, u), await probe.keyboard(b, u)];
  assert.deepEqual(f.data.noVisibleChange, []); assert.ok(f.data.measured >= 5);
  assert.deepEqual(f.data.lowContrast, []);
  assert.equal(r.data.horizontalScroll, false);
  assert.deepEqual(t.data.newlyClipped, []); assert.deepEqual(s.data.newlyClipped, []);
  assert.deepEqual(k.data.suspectedTraps, []); assert.deepEqual(k.data.forward.notReached, []); assert.deepEqual(k.data.backward.notReached, []);
});

test('bad page: every planted defect is measured', async () => {
  const u = site.base + '/bad', d = await inv('/bad');
  assert.equal(d.lang, null); assert.equal(d.hasTitle, false); assert.equal(d.doctype, null);
  assert.deepEqual(d.duplicateIds, ['d x2']);
  assert.equal(d.images[0].alt, null); assert.equal(d.frames[0].title, null);
  assert.ok(d.clickableNotFocusable.some((x: any) => x.name === 'Ouvrir' || x.tag === 'div'));
  assert.equal(d.positiveTabindex.length, 1); assert.equal(d.documents.length, 1);
  const f = await probe.focus(b, u);
  assert.equal(f.data.noVisibleChange.length, 1, JSON.stringify(f.data.items));
  assert.ok(f.image);
  const r = await probe.reflow(b, u);
  assert.equal(r.data.horizontalScroll, true); assert.ok(r.data.wide.some((w: any) => w.text.includes('Bloc large')));
  assert.ok((await probe.text200(b, u)).data.newlyClipped.some((x: string) => x.includes('Un texte')));
  const n = await probe.nocss(b, u);
  assert.ok(n.data.generatedContent.some((x: any) => x.content.includes('Obligatoire')));
  const o = await b.open(u);
  try { const a = (await probe.axe(o.page)).data.results.map((x: any) => x.rule); for (const rule of ['image-alt', 'frame-title', 'color-contrast', 'html-has-lang']) assert.ok(a.includes(rule), rule); } finally { await o.close(); }
});

test('direct verdicts: right, and never C or NA when the fact is absent', async () => {
  const bad = await auto('/bad');
  for (const t of ['2.1.1', '8.1.1', '8.5.1', '8.2.1']) assert.equal(bad.get(t)?.verdict, 'NC', t);
  for (const t of ['8.3.1', '1.1.1', '6.2.1']) assert.equal(bad.get(t), undefined, t);
  const empty = await auto('/empty');
  for (const t of ['1.1.1', '2.1.1', '5.6.1', '6.2.1', '11.1.1', '11.9.1']) assert.equal(empty.get(t)?.verdict, 'NA', t);
  assert.equal(empty.get('4.1.1')?.confidence, 'unmeasured', 'scripts could create media');
  assert.equal(empty.get('4.10.1'), undefined);
  const good = await auto('/good');
  for (const t of ['8.1.1', '8.1.2', '8.1.3', '8.3.1', '8.5.1']) assert.equal(good.get(t)?.verdict, 'C', t);
  for (const t of ['1.1.1', '11.1.1', '6.1.1']) assert.equal(good.get(t), undefined, t);
  assert.equal((await auto('/shadow')).get('1.1.1'), undefined, 'an image inside a shadow root counts');
});

test('keyboard: traps found, radios and date fields are not traps', async () => {
  assert.match((await probe.keyboard(b, site.base + '/stuck')).data.suspectedTraps.join(), /stuck/);
  const loop = await probe.keyboard(b, site.base + '/loop');
  assert.match(loop.data.suspectedTraps.join(), /loop/); assert.ok(loop.data.forward.notReached.length >= 1);
  assert.deepEqual((await probe.keyboard(b, site.base + '/radio')).data.suspectedTraps, []);
});

test('keyboard and focus follow the iframe content and come out', async () => {
  const k = (await probe.keyboard(b, site.base + '/framed')).data;
  assert.deepEqual(k.suspectedTraps, []); assert.deepEqual(k.forward.notReached, []);
  assert.equal(k.forward.stops.filter((s: any) => s.path.includes(' => ')).length, 20);
  assert.equal(k.forward.stops.at(-1).name, 'Après');
  const f = (await probe.focus(b, site.base + '/framed')).data;
  assert.equal(f.measured, 22, f.end); assert.deepEqual(f.noVisibleChange, []);
});

test('fake buttons are found inside a main with tabindex -1', async () => {
  assert.deepEqual((await inv('/fake')).clickableNotFocusable.map((x: any) => x.path), ['#k', '#m']);
});

test('form errors: linked messages and unlinked messages are told apart', async () => {
  const [g] = await probe.formErrors(b, site.base + '/good', 'empty');
  const nom = g.data.fieldsAfter.find((x: any) => x.path === '#nom');
  assert.equal(nom.ariaInvalid, 'true'); assert.deepEqual(nom.describedby, ['Erreur : Saisissez votre nom.']);
  assert.equal(g.data.focusAfter.path, '#nom');
  const [i] = await probe.formErrors(b, site.base + '/good', 'invalid');
  assert.ok(i.data.newText.some((x: any) => x.text.includes('format attendu')));
  const [x] = await probe.formErrors(b, site.base + '/badform', 'empty');
  assert.ok(x.data.newText.some((t: any) => t.text === 'Erreur dans le formulaire'));
  assert.deepEqual(x.data.fieldsAfter[0].describedby, []);
});

test('form with server errors: blocked and said so', async () => {
  const n = site.writes.length;
  const [r] = await probe.formErrors(b, site.base + '/serverform', 'empty');
  assert.equal(site.writes.length, n); assert.equal(r.data.blocked.length, 1); assert.match(r.data.limits, /NOT seen/);
});

test('SAFETY: a page trying every kind of write sends none', async () => {
  const n = site.writes.length, u = site.base + '/writes';
  const o = await b.open(u); await o.page.waitForTimeout(800); await o.close();
  await probe.interact(b, u, [{ action: 'click', selector: '#go' }, { action: 'wait', value: '800' }]);
  await probe.keyboard(b, u);
  assert.deepEqual(site.writes.slice(n), []);
});

test('SAFETY: the same page does write when a person allows it (the test above is meaningful)', async () => {
  const n = site.writes.length, box = new GuardedBrowser(policyFromEnv({ RGAA_SANDBOX: '1' }));
  try { const o = await box.open(site.base + '/writes'); await o.page.waitForTimeout(800); await o.close(); } finally { await box.close(); }
  const w = site.writes.slice(n);
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.ok(w.some((x) => x.startsWith(m)), m);
});

test('SAFETY: irreversible names, outside links and redirects are stopped', async () => {
  const u = site.base + '/danger', g = site.gets.length;
  const [f] = await probe.formErrors(b, u, 'empty');
  assert.match(f.data.skipped, /irreversible/);
  for (const s of [{ action: 'click' as const, selector: '#out' }, { action: 'press' as const, selector: '#out', value: 'Enter' }]) {
    assert.match((await probe.interact(b, u, [s])).data.log[0].error, /refused/);
  }
  const ext = await probe.interact(b, u, [{ action: 'click', selector: '#ext' }]);
  assert.match(ext.data.log[0].blocked.join(), /outside the authorised/); assert.equal(ext.data.log[0].url, u);
  assert.ok(!site.gets.slice(g).includes('/logout') && !site.gets.slice(g).includes('/submit'));
  await assert.rejects(b.open(site.base + '/redirect'));
  await assert.rejects(b.open('https://example.com/'), /Not authorised/);
});

test('selectors reach inside open shadow roots', async () => {
  const d = await inv('/shadow');
  assert.equal(d.buttons.length, 1); assert.equal(d.shadowRoots, 1);
  assert.equal((await probe.element(b, site.base + '/shadow', d.buttons[0].path)).data.text, 'Dans ombre');
});

test('mutations: breaking one thing changes the matching measurement', async () => {
  const cases: [string, (h: string) => string, (p: string) => Promise<boolean>][] = [
    ['title', (h) => h.replace(/<title>.*?<\/title>/, ''), async (p) => (await auto(p)).get('8.5.1')?.verdict === 'NC'],
    ['lang', (h) => h.replace(' lang="fr"', ''), async (p) => !(await auto(p)).has('8.3.1')],
    ['doctype', (h) => h.replace('<!doctype html>', ''), async (p) => (await auto(p)).get('8.1.1')?.verdict === 'NC'],
    ['alt', (h) => h.replace(/ alt="[^"]*"/, ''), async (p) => (await inv(p)).images[0].alt === null],
    ['label', (h) => h.replace('<label for="nom">Nom (obligatoire)</label>', 'Nom'), async (p) => (await inv(p)).fields[0].labels.length === 0],
    ['error link', (h) => h.replace(' aria-describedby="nom-e"', ''), async (p) => (await probe.formErrors(b, site.base + p, 'empty'))[0].data.fieldsAfter[0].describedby.length === 0],
    ['focus style', (h) => h.replace(/:focus-visible\{[^}]*\}/, ':focus{outline:none!important}'), async (p) => (await probe.focus(b, site.base + p)).data.noVisibleChange.length > 0],
    ['reflow', (h) => h.replace('max-width:60rem', 'width:60rem'), async (p) => (await probe.reflow(b, site.base + p)).data.horizontalScroll],
    ['heading', (h) => h.replace('<h1>Demande de carte</h1>', '<p>Demande de carte</p>'), async (p) => (await inv(p)).headings.length === 0],
    ['skip link', (h) => h.replace('href="#main"', 'href="#nulle"'), async (p) => (await inv(p)).skipLinks[0].target === false],
  ];
  for (const [name, change, found] of cases) {
    const broken = change(GOOD);
    assert.notEqual(broken, GOOD, name);
    site.set('/good', GOOD); assert.equal(await found('/good'), false, `${name}: reported on the good page`);
    site.set('/mut', broken); assert.equal(await found('/mut'), true, `${name}: not detected`);
  }
});

test('a large page stays within the time and size an MCP call allows', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => `<section><h2>Titre ${i}</h2><p>Paragraphe ${i} avec <a href="/plan?${i}">un lien ${i}</a> et du texte.</p><img src="/pic.png" alt="image ${i}" width="60" height="40"></section>`).join('');
  site.set('/large', `<!doctype html><html lang="fr"><head><title>Grande page</title></head><body><main>${rows}<table><tr><th scope="col">A</th></tr>${'<tr><td>1</td></tr>'.repeat(200)}</table></main></body></html>`);
  const store = new Store(mkdtempSync(join(tmpdir(), 'rgaa-l-')));
  const a: Audit = { id: 'large-1', name: 'l', created: '', pack: '4.1.2', packHash: '', tool: '', sandbox: false, pages: [{ id: 'P1', url: `${site.base}/large`, name: 'l', collected: false, notes: [] }], evidence: [], verdicts: {}, model: '', nextEvidence: 1 };
  store.save(a);
  const t = Date.now();
  const r = await collect(store, b, pack, a.id, 'P1');
  assert.deepEqual(r.errors, []);
  assert.ok(Date.now() - t < 110_000, `${Date.now() - t} ms`);
  const done = store.load(a.id);
  for (const only of pack.criteria.map((c) => c.id)) {
    const n = nextTasks(store, done, pack, 'P1', 10, false, only);
    if (n) assert.ok(n.rules.length + n.data.length < 50_000, `${only}: ${n.rules.length + n.data.length}`);
  }
  const k = JSON.parse(store.readEvidence(done, done.evidence.find((e) => e.kind === 'keyboard')!));
  assert.deepEqual(k.suspectedTraps, []);
  for (const kind of ['keyboard', 'focus', 'images']) assert.ok(done.evidence.find((e) => e.kind === kind)!.partial, kind);
  assert.equal(k.forward.end, 'limit reached', 'a partial walk says it is partial');
});
