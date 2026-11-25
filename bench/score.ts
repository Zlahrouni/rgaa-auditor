// SPDX-License-Identifier: AGPL-3.0-or-later
// Compares audits with an answer key. The key stays outside this project so the AI cannot read it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { testStatus, type Audit, type Status, type TestVerdict } from '../src/ledger.ts';
import { loadPack, type Pack } from '../src/pack.ts';
import { Store } from '../src/store.ts';

export interface Expected { expect: 'C' | 'NC' | 'NA'; at?: string[]; why?: string }
export interface Key { name: string; rgaa: string; reviewedByAuditor: boolean; pages: Record<string, Record<string, Expected>> }
export type Outcome = 'correct' | 'falseAlarm' | 'wrongC' | 'wrongNA' | 'undecidedNC' | 'undecided' | 'mixedCNA';
export interface Row { page: string; test: string; expect: string; got: Status; who: 'AI' | 'engine' | 'person' | 'nobody'; outcome: Outcome; place?: boolean; disputed: boolean }
export interface Tally { total: number; correct: number; falseAlarms: number; missed: number; wrongC: number; wrongNA: number; undecided: number; mixedCNA: number; expectedNC: number; reportedNC: number }

export function checkKey(key: Key, pack: Pack): void {
  if (key.rgaa !== pack.version) throw new Error(`the key is for RGAA ${key.rgaa}, the data is ${pack.version}`);
  const known = new Set(pack.criteria.flatMap((c) => c.tests.map((t) => t.id)));
  for (const [p, tests] of Object.entries(key.pages)) for (const [t, e] of Object.entries(tests)) {
    if (!known.has(t)) throw new Error(`key ${p}: unknown test ${t}`);
    if (!['C', 'NC', 'NA'].includes(e.expect)) throw new Error(`key ${p} ${t}: bad answer ${e.expect}`);
  }
}

export function outcome(expect: Expected['expect'], got: Status): Outcome {
  if (got === expect) return 'correct';
  const open = got === 'OPEN' || got === 'BLOCKED';
  if (expect === 'NC') return open ? 'undecidedNC' : got === 'C' ? 'wrongC' : 'wrongNA';
  return open ? 'undecided' : got === 'NC' ? 'falseAlarm' : 'mixedCNA';
}

function author(v?: TestVerdict): Row['who'] {
  if (!v) return 'nobody';
  if (v.confidence === 'confirmed') return 'person';
  return v.by === 'engine' ? 'engine' : 'AI';
}
const pathOf = (url: string) => new URL(url).pathname;

export function grade(a: Audit, key: Key): { rows: Row[]; missingPages: string[]; outside: string[] } {
  const rows: Row[] = [], outside: string[] = [];
  for (const [path, tests] of Object.entries(key.pages)) {
    const pages = a.pages.filter((p) => pathOf(p.url) === path);
    if (pages.length > 1) throw new Error(`audit ${a.id} contains ${path} twice`);
    if (!pages.length) continue;
    const verdicts = a.verdicts[pages[0].id] ?? {};
    for (const [test, e] of Object.entries(tests)) {
      const v = verdicts[test], got = testStatus(v);
      const row: Row = { page: path, test, expect: e.expect, got, who: author(v), outcome: outcome(e.expect, got), disputed: !!v?.check && v.check.outcome !== 'uphold' };
      if (e.expect === 'NC' && got === 'NC' && e.at) row.place = e.at.some((x) => v.elements?.some((y) => y.includes(x)) ?? false);
      rows.push(row);
    }
    for (const v of Object.values(verdicts)) {
      if (!tests[v.test] && testStatus(v) === 'NC') outside.push(`${path} ${v.test}: ${(v.elements ?? []).slice(0, 3).join(' ; ')}`);
    }
  }
  return { rows, missingPages: Object.keys(key.pages).filter((p) => !a.pages.some((x) => pathOf(x.url) === p)), outside };
}

export function tally(rows: Row[]): Tally {
  const n = (...o: Outcome[]) => rows.filter((r) => o.includes(r.outcome)).length;
  return {
    total: rows.length, correct: n('correct'), falseAlarms: n('falseAlarm'), missed: n('wrongC', 'wrongNA', 'undecidedNC'),
    wrongC: n('wrongC'), wrongNA: n('wrongNA'), undecided: n('undecided', 'undecidedNC'), mixedCNA: n('mixedCNA'),
    expectedNC: rows.filter((r) => r.expect === 'NC').length, reportedNC: rows.filter((r) => r.got === 'NC').length,
  };
}

/** 95% Wilson interval, or null when there is nothing to count. */
export function interval(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** Scored tests that got the same answer in every run. */
export function stability(runs: Row[][]): { same: number; total: number; changed: string[] } {
  const find = (rows: Row[], r: Row) => rows.find((y) => y.page === r.page && y.test === r.test);
  const common = (runs[0] ?? []).filter((r) => runs.every((x) => find(x, r)));
  const changed: string[] = [];
  for (const r of common) {
    const got = runs.map((x) => find(x, r)!.got);
    if (new Set(got).size > 1) changed.push(`${r.page} ${r.test}: ${got.join(' / ')} (key ${r.expect})`);
  }
  return { same: common.length - changed.length, total: common.length, changed };
}

function share(k: number, n: number): string {
  const i = interval(k, n), f = (x: number) => (100 * x).toFixed(0);
  return i ? `${k}/${n} = ${f(k / n)}% (95%: ${f(i[0])}-${f(i[1])}%)` : 'nothing to count';
}
export function render(t: Tally): string {
  return [
    `  Scored tests        ${t.total}`,
    `  Correct             ${share(t.correct, t.total)}`,
    `  False alarms        ${share(t.falseAlarms, t.reportedNC)} of reported failures`,
    `  Missed failures     ${share(t.missed, t.expectedNC)} of real failures`,
    `    as wrong C        ${t.wrongC}   <- most dangerous`,
    `    as wrong NA       ${t.wrongNA}`,
    `  Undecided           ${t.undecided} (those on real failures are also counted as missed)`,
    `  C and NA mixed up   ${t.mixedCNA}`,
  ].join('\n');
}

function main(argv: string[]): void {
  const [keyFile, ...ids] = argv;
  const pack = loadPack();
  const store = new Store(process.env.RGAA_AUDITS ?? fileURLToPath(new URL('../audits', import.meta.url)));
  if (!keyFile || !ids.length) throw new Error(`usage: npm run score -- <key.json> <audit> [audit...]\nAudits: ${store.list().join(', ') || 'none'}`);
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as Key;
  checkKey(key, pack);
  const runs: Row[][] = [];
  const block = (title: string, lines: string[]) => { if (lines.length) console.log(`\n${title}\n${lines.map((x) => `  ${x}`).join('\n')}`); };
  for (const id of ids) {
    const a = store.load(id), g = grade(a, key);
    if (!g.rows.length) throw new Error(`audit ${id} has none of the pages of this key`);
    runs.push(g.rows);
    console.log(`\n=== ${id}: ${a.model} ===`);
    block('Pages not audited, so not scored', g.missingPages);
    const groups: [string, Row['who'][]][] = [['AI (including tests nobody decided)', ['AI', 'nobody']], ['Direct measurements, no AI', ['engine']], ['Answers given by a person', ['person']]];
    for (const [title, list] of groups) {
      const rows = g.rows.filter((r) => list.includes(r.who));
      if (rows.length) console.log(`\n${title}\n${render(tally(rows))}`);
    }
    block('Differences', g.rows.filter((r) => r.outcome !== 'correct').map((r) => `${r.page} ${r.test}: key ${r.expect}, audit ${r.got}${r.disputed ? ' (disputed by the second look)' : ''} [${r.who}] ${r.outcome}`));
    block('NC counted as correct, but another element was cited: check by eye', g.rows.filter((r) => r.place === false).map((r) => `${r.page} ${r.test}`));
    block('Failures reported outside the key: not scored, an auditor should look', g.outside);
  }
  if (runs.length > 1) {
    const s = stability(runs);
    console.log(`\n=== Stability over ${runs.length} runs ===\n  Same answer: ${s.same}/${s.total}`);
    block('Changed', s.changed);
  }
  console.log('\nThese figures describe small exam pages only. They are not RGAA accuracy.');
  if (!key.reviewedByAuditor) console.log('The answer key has NOT been reviewed by an auditor.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
