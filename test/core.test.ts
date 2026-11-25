// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack } from '../src/pack.ts';
import { combine, pageStatus, rate, record, refuse, serviceStatus, type Audit, type NewVerdict, type Status } from '../src/ledger.ts';
import { dangerous, decide, originAllowed, policyFromEnv } from '../src/guard.ts';
import { Store } from '../src/store.ts';

const pack = loadPack();
const R = 'a sufficiently long reason';
function audit(): Audit {
  const ev = (id: string, page: string, kind: 'inventory' | 'forms') => ({ id, page, kind, label: '', file: '', at: '' });
  return {
    id: 'a-1', name: 'a', created: '', pack: '4.1.2', packHash: '', tool: '', sandbox: false,
    pages: ['P1', 'P2'].map((id) => ({ id, url: 'http://localhost/', name: id, collected: true, notes: [] })),
    evidence: [ev('E1', 'P1', 'inventory'), ev('E2', 'P2', 'inventory'), ev('E3', 'P1', 'forms')],
    verdicts: {}, model: '', nextEvidence: 4,
  };
}
const many = (C: number, NC: number, NA: number, OPEN = 0): Status[] =>
  [...Array<Status>(C).fill('C'), ...Array<Status>(NC).fill('NC'), ...Array<Status>(NA).fill('NA'), ...Array<Status>(OPEN).fill('OPEN')];

test('official data: 106 criteria, 258 tests, each with a method', () => {
  assert.equal(pack.criteria.length, 106);
  assert.equal(pack.criteria.flatMap((c) => c.tests).length, 258);
  assert.ok(pack.criteria.every((c) => c.tests.every((t) => t.text && t.method)));
});

test('criterion combination never defaults to C', () => {
  const cases: [Status[], Status][] = [
    [['C', 'NA'], 'C'], [['NA', 'NA'], 'NA'], [['C', 'OPEN'], 'OPEN'], [['NC', 'OPEN'], 'NC'],
    [['C', 'BLOCKED'], 'BLOCKED'], [['BLOCKED', 'NC'], 'NC'], [[], 'OPEN'],
  ];
  for (const [i, o] of cases) assert.equal(combine(i), o);
});

test('service: a criterion fails if one page fails', () => {
  const a = audit(), c = pack.byId.get('8.5')!;
  record(a, 'P1', { test: '8.5.1', verdict: 'C', reason: R, evidence: ['E1'] }, 'proven', 't');
  assert.equal(serviceStatus(a, c), 'OPEN');
  record(a, 'P2', { test: '8.5.1', verdict: 'NC', reason: R, evidence: ['E2'] }, 'proven', 't');
  assert.equal(serviceStatus(a, c), 'NC');
  assert.equal(pageStatus(a, c, 'P1'), 'C');
});

test('rate: hand-worked examples', () => {
  assert.equal(rate(many(45, 15, 46)).rate, 0.75);
  const r = rate(many(40, 10, 46, 10));
  assert.equal(r.rate, null);
  assert.equal(r.low, 40 / 60);
  assert.equal(r.high, 50 / 60);
  assert.equal(rate(many(0, 0, 106)).rate, null);
  assert.equal(rate([]).complete, false);
});

test('rate range bounds every way the undecided criteria can resolve', () => {
  for (const [C, NC, u] of [[3, 2, 3], [0, 1, 2], [4, 0, 2], [0, 0, 2]]) {
    const r = rate(many(C, NC, 0, u));
    for (let c = 0; c <= u; c++) for (let n = 0; n + c <= u; n++) {
      const d = C + NC + c + n;
      if (d) assert.ok((C + c) / d >= r.low! - 1e-9 && (C + c) / d <= r.high! + 1e-9, `${C},${NC},${u}`);
    }
  }
});

test('verdicts without proof are refused', () => {
  const a = audit();
  const no = (v: Partial<NewVerdict>) => refuse(a, pack, 'P1', { test: '6.2.1', verdict: 'C', reason: R, evidence: ['E1'], ...v }).length > 0;
  assert.ok(no({ test: '9.9.9' }));
  assert.ok(no({ evidence: [] }));
  assert.ok(no({ evidence: ['E99'] }));
  assert.ok(no({ evidence: ['E2'] }), 'evidence from another page');
  assert.ok(no({ verdict: 'NC' }), 'NC without element and impact');
  assert.ok(no({ verdict: 'NA', evidence: ['E3'] }), 'NA without inventory');
  assert.ok(no({ test: '11.10.1' }), 'form errors need form evidence');
  assert.ok(!no({ test: '11.10.1', evidence: ['E3'] }));
  assert.ok(no({ test: '7.1.1' }), 'no screen reader, no C');
  assert.ok(no({ test: '12.1.1' }), 'cross-page needs two pages');
  assert.ok(!no({ test: '12.1.1', evidence: ['E1', 'E2'] }));
  assert.ok(!no({ verdict: 'NC', elements: ['a'], impact: 'a person cannot know the target' }));
});

test('partial evidence can prove a failure, never a C', () => {
  const a = audit();
  a.evidence.push({ id: 'E9', page: 'P1', kind: 'keyboard', label: '', file: '', at: '', partial: 'limit' });
  const v = { test: '12.9.1', reason: R, evidence: ['E9'], elements: ['a'], impact: 'the keyboard user stays stuck' };
  assert.match(refuse(a, pack, 'P1', { ...v, verdict: 'C' }).join(), /partial/);
  assert.deepEqual(refuse(a, pack, 'P1', { ...v, verdict: 'NC' }), []);
});

test('a proven verdict cannot be overwritten, a disputed one reopens', () => {
  const a = audit();
  record(a, 'P1', { test: '8.5.1', verdict: 'NC', reason: R, evidence: ['E1'] }, 'proven', 't');
  assert.ok(refuse(a, pack, 'P1', { test: '8.5.1', verdict: 'C', reason: R, evidence: ['E1'] }).length > 0);
  a.verdicts.P1['8.5.1'].check = { outcome: 'refute', reason: R, by: 'x', at: '' };
  assert.equal(pageStatus(a, pack.byId.get('8.5')!, 'P1'), 'OPEN');
});

test('guard: scope and writes', () => {
  const p = policyFromEnv({ RGAA_ALLOWED_ORIGINS: 'https://example.org' });
  const ok = (method: string, url: string, mainNavigation = false, q = p) => decide({ method, url, mainNavigation }, q).allow;
  assert.ok(originAllowed('http://localhost:3000/x', p));
  assert.ok(originAllowed('https://example.org/a', p));
  for (const u of ['https://evil.org', 'file:///c:/x', 'http://example.org', 'https://localhost.evil.org',
    'http://u:p@localhost/', 'javascript:1', 'https://example.org.evil.org']) assert.equal(originAllowed(u, p), false, u);
  assert.ok(ok('GET', 'https://cdn.org/a.js'));
  assert.ok(!ok('GET', 'https://cdn.org/', true));
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'FOO']) assert.ok(!ok(m, 'http://localhost:3000/x'), m);
  const box = policyFromEnv({ RGAA_SANDBOX: '1', RGAA_ALLOWED_ORIGINS: 'https://example.org' });
  assert.ok(ok('POST', 'http://localhost:3000/x', false, box));
  assert.ok(!ok('POST', 'https://example.org/x', false, box), 'sandbox is for local addresses only');
  const w = policyFromEnv({ RGAA_ALLOW_WRITES: 'POST http://localhost:3000/graphql' });
  assert.ok(ok('POST', 'http://localhost:3000/graphql', false, w));
  assert.ok(!ok('POST', 'http://localhost:3000/graphql/x', false, w));
});

test('guard: dangerous names', () => {
  for (const n of ['Supprimer mon compte', 'Se déconnecter', 'Déconnexion', 'Payer', 'Delete', 'Logout']) assert.ok(dangerous(n), n);
  for (const n of ['Suivant', 'Rechercher', 'Accueil', 'Voir le détail']) assert.ok(!dangerous(n), n);
});

test('store: audit ids cannot escape the folder', () => {
  const s = new Store(mkdtempSync(join(tmpdir(), 'rgaa-')));
  for (const id of ['../x', 'a/b', '..', 'C:\\x']) assert.throws(() => s.load(id));
  assert.match(s.newId('Démo : été'), /^[a-z0-9-]+$/);
});
