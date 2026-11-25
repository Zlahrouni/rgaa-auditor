// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKey, grade, interval, outcome, stability, tally, type Key } from '../bench/score.ts';
import { record, type Audit, type Verdict } from '../src/ledger.ts';
import { loadPack } from '../src/pack.ts';

const NC = { expect: 'NC' as const }, C = { expect: 'C' as const };
const key: Key = { name: 'k', rgaa: '4.1.2', reviewedByAuditor: false, pages: { '/x': {
  '1.1.1': { ...NC, at: ['#i'] }, '6.2.1': NC, '3.2.1': NC, '8.5.1': NC, '9.1.1': C, '9.3.1': C, '5.6.1': { expect: 'NA' } } } };

function audit(v: Record<string, Verdict>, elements = ['#i']): Audit {
  const a: Audit = { id: 'a', name: '', created: '', pack: '', packHash: '', tool: '', sandbox: false, model: 'm', nextEvidence: 1,
    pages: [{ id: 'P1', url: 'http://localhost:1/x?q=1', name: '', collected: true, notes: [] }], evidence: [], verdicts: {} };
  for (const [t, verdict] of Object.entries(v)) record(a, 'P1', { test: t, verdict, reason: 'r', evidence: [], elements }, 'unmeasured', 'm');
  return a;
}
const every = (f: (expect: Verdict) => Verdict): Record<string, Verdict> =>
  Object.fromEntries(Object.entries(key.pages['/x']).map(([t, e]) => [t, f(e.expect)]));
const score = (v: Record<string, Verdict>) => tally(grade(audit(v), key).rows);

test('each kind of error is counted in the right place', () => {
  assert.deepEqual(score({ '1.1.1': 'NC', '6.2.1': 'C', '3.2.1': 'BLOCKED', '9.1.1': 'NC', '9.3.1': 'NA', '5.6.1': 'NA' }),
    { total: 7, correct: 2, falseAlarms: 1, missed: 3, wrongC: 1, wrongNA: 0, undecided: 2, mixedCNA: 1, expectedNC: 4, reportedNC: 2 });
});

test('perfect, empty, always C and always NC audits', () => {
  const p = score(every((e) => e));
  assert.equal(p.correct, 7);
  assert.equal(p.missed + p.falseAlarms + p.undecided, 0);
  const e = score({});
  assert.deepEqual([e.correct, e.missed, e.undecided], [0, 4, 7]);
  assert.equal(score(every(() => 'C')).wrongC, 4);
  assert.equal(score(every(() => 'NA')).wrongNA, 4);
  assert.equal(score(every(() => 'NC')).falseAlarms, 3);
});

test('who answered, disputed failures and the cited element', () => {
  const a = audit({ '1.1.1': 'NC', '6.2.1': 'NC' }, ['#other']);
  record(a, 'P1', { test: '8.5.1', verdict: 'NC', reason: 'r', evidence: [] }, 'proven', 'engine');
  a.verdicts.P1['6.2.1'].check = { outcome: 'unsure', reason: '', by: '', at: '' };
  const r = new Map(grade(a, key).rows.map((x) => [x.test, x]));
  assert.equal(r.get('8.5.1')!.who, 'engine');
  assert.equal(r.get('1.1.1')!.place, false);
  assert.equal(r.get('6.2.1')!.outcome, 'undecidedNC');
  assert.equal(r.get('3.2.1')!.who, 'nobody');
});

test('failures outside the key are listed, pages not audited are not scored', () => {
  const g = grade(audit({ '10.7.1': 'NC' }), { ...key, pages: { ...key.pages, '/y': { '1.1.1': C } } });
  assert.equal(g.outside.length, 1);
  assert.deepEqual(g.missingPages, ['/y']);
  assert.equal(g.rows.length, 7);
});

test('stability, intervals and key validation', () => {
  const r = (v: Verdict) => grade(audit({ '9.1.1': v }), key).rows;
  assert.equal(stability([r('C'), r('C')]).same, 7);
  assert.equal(stability([r('C'), r('NC')]).same, 6);
  assert.equal(outcome('NC', 'OPEN'), 'undecidedNC');
  assert.equal(interval(0, 0), null);
  assert.ok(interval(0, 59)![1] < 0.07);
  assert.throws(() => checkKey({ ...key, pages: { '/x': { '99.1.1': C } } }, loadPack()));
  assert.throws(() => checkKey({ ...key, rgaa: '5' }, loadPack()));
});
