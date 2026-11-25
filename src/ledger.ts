// SPDX-License-Identifier: AGPL-3.0-or-later
// The audit ledger: the only place where verdicts are accepted, combined and turned into rates.
import type { Criterion, Pack } from './pack.ts';

export type Verdict = 'C' | 'NC' | 'NA' | 'BLOCKED';
export type Confidence = 'proven' | 'unmeasured' | 'confirmed';
export type EvidenceKind = 'inventory' | 'axe' | 'screenshot' | 'crop' | 'images' | 'keyboard' | 'focus'
  | 'reflow' | 'text200' | 'spacing' | 'nocss' | 'forms' | 'interaction' | 'element' | 'speech';

export interface Evidence { id: string; page: string; kind: EvidenceKind; label: string; file: string; image?: string; at: string; partial?: string }
export interface TestVerdict {
  test: string; verdict: Verdict; reason: string; evidence: string[];
  elements?: string[]; impact?: string; blocking?: boolean;
  confidence: Confidence; by: string; at: string;
  check?: { outcome: 'uphold' | 'refute' | 'unsure'; reason: string; by: string; at: string };
}
export interface Page { id: string; url: string; name: string; collected: boolean; title?: string; notes: string[] }
export interface Audit {
  id: string; name: string; created: string; pack: string; packHash: string; tool: string;
  sandbox: boolean; pages: Page[]; evidence: Evidence[];
  verdicts: Record<string, Record<string, TestVerdict>>; // page -> test -> verdict
  model: string; nextEvidence: number;
}

export type Status = Verdict | 'OPEN';

/** Evidence a C needs, at least one kind per inner group. Without it the server refuses the C. */
const C_NEEDS: Record<string, EvidenceKind[][]> = {
  '1.1': [['images', 'crop', 'element']], '1.2': [['images', 'crop']], '1.3': [['images', 'crop']], '1.6': [['images', 'crop']],
  '1.7': [['images', 'crop']], '1.8': [['images', 'crop']],
  '3.1': [['screenshot', 'crop']], '3.2': [['axe'], ['screenshot', 'crop']], '3.3': [['screenshot', 'crop']],
  '4.11': [['keyboard', 'interaction']], '4.12': [['keyboard', 'interaction']],
  '7.3': [['keyboard'], ['interaction', 'inventory']], '7.4': [['interaction', 'forms']],
  '9.1': [['screenshot']], '9.3': [['screenshot']],
  '10.2': [['nocss']], '10.3': [['nocss']], '10.4': [['text200']], '10.6': [['screenshot', 'crop']], '10.7': [['focus']],
  '10.9': [['screenshot', 'crop']], '10.10': [['screenshot', 'crop']], '10.11': [['reflow']], '10.12': [['spacing']],
  '10.13': [['interaction']], '10.14': [['interaction']],
  '11.4': [['screenshot', 'crop']], '11.10': [['forms']], '11.11': [['forms']],
  '12.7': [['keyboard']], '12.8': [['keyboard']], '12.9': [['keyboard']], '12.11': [['keyboard', 'interaction']],
  '13.9': [['interaction']],
};
/** Checks this version has no instrument for: C is refused, NC and NA stay possible. */
export const NO_INSTRUMENT: Record<string, string> = {
  '4.13': 'real screen reader', '7.1': 'real screen reader', '7.5': 'real screen reader',
  '8.2': 'HTML validator', '4.2': 'media analysis', '4.4': 'media analysis', '4.6': 'media analysis',
  '13.1': 'server-side session limits', '13.3': 'document checker', '13.4': 'document checker', '13.7': 'flash analysis',
  '13.12': 'mobile device', '13.10': 'touch device',
};
const CROSS_PAGE = new Set(['12.1', '12.2', '12.3', '12.4', '12.5']);

export interface NewVerdict { test: string; verdict: Verdict; reason: string; evidence: string[]; elements?: string[]; impact?: string; blocking?: boolean }

export const criterionOf = (test: string) => test.split('.').slice(0, 2).join('.');

export function needsFor(criterion: string): string[] {
  const out = (C_NEEDS[criterion] ?? []).map((g) => g.join(' or '));
  if (CROSS_PAGE.has(criterion)) out.push('inventory of at least two pages');
  return out;
}

/** Returns the reasons to refuse the verdict; empty means accepted. */
export function refuse(audit: Audit, pack: Pack, pageId: string, v: NewVerdict): string[] {
  const out: string[] = [];
  const page = audit.pages.find((p) => p.id === pageId);
  if (!page) return [`unknown page ${pageId}`];
  const crit = pack.byId.get(criterionOf(v.test));
  if (!crit || !crit.tests.some((t) => t.id === v.test)) return [`unknown test ${v.test}`];
  if (!page.collected) out.push('page not collected yet');
  if (v.reason.trim().length < 10) out.push('reason too short');
  const old = audit.verdicts[pageId]?.[v.test];
  if (old?.confidence === 'proven') out.push(`already proven ${old.verdict} by direct measurement`);
  if (old?.confidence === 'confirmed') out.push('already confirmed by a person');
  const found: Evidence[] = [];
  for (const id of v.evidence) {
    const e = audit.evidence.find((x) => x.id === id);
    if (e) found.push(e); else out.push(`unknown evidence ${id}`);
  }
  const own = found.filter((e) => e.page === pageId);
  if (v.verdict !== 'BLOCKED' && own.length === 0) out.push('no evidence from this page');
  const kinds = new Set(own.map((e) => e.kind));
  if (v.verdict === 'NC') {
    if (!v.elements?.length) out.push('NC needs at least one element');
    if (!v.impact || v.impact.trim().length < 10) out.push('NC needs the impact on a person');
  }
  if (v.verdict === 'NA' && !kinds.has('inventory')) out.push('NA needs the page inventory as evidence');
  if (v.verdict === 'C') {
    const missing = NO_INSTRUMENT[crit.id];
    if (missing) out.push(`C refused: this version has no ${missing}; use BLOCKED, NC or NA`);
    for (const group of C_NEEDS[crit.id] ?? []) {
      const fit = own.filter((e) => group.includes(e.kind));
      if (!fit.length) out.push(`C needs evidence of kind ${group.join(' or ')}`);
      else if (fit.every((e) => e.partial)) out.push(`C refused: the ${fit[0].kind} evidence is partial (${fit[0].partial}); use BLOCKED or collect more`);
    }
    const inventories = new Set(found.filter((e) => e.kind === 'inventory').map((e) => e.page));
    if (CROSS_PAGE.has(crit.id) && inventories.size < 2) out.push('C needs inventories from at least two pages');
  }
  return out;
}

export function record(audit: Audit, pageId: string, v: NewVerdict, confidence: Confidence, by: string): void {
  (audit.verdicts[pageId] ??= {})[v.test] = { ...v, confidence, by, at: new Date().toISOString() };
}

/** A verdict that a second check did not uphold counts as undecided. */
export function testStatus(v?: TestVerdict): Status {
  if (!v) return 'OPEN';
  return v.check && v.check.outcome !== 'uphold' ? 'OPEN' : v.verdict;
}

/** One NC fails the criterion. It is C only if every test is decided and at least one applies. */
export function combine(list: Status[]): Status {
  if (list.includes('NC')) return 'NC';
  if (list.length === 0 || list.includes('OPEN')) return 'OPEN';
  if (list.includes('BLOCKED')) return 'BLOCKED';
  return list.every((s) => s === 'NA') ? 'NA' : 'C';
}
export const pageStatus = (audit: Audit, c: Criterion, pageId: string): Status =>
  combine(c.tests.map((t) => testStatus(audit.verdicts[pageId]?.[t.id])));
export const serviceStatus = (audit: Audit, c: Criterion): Status =>
  combine(audit.pages.map((p) => pageStatus(audit, c, p.id)));

export interface Rate {
  C: number; NC: number; NA: number; BLOCKED: number; OPEN: number; total: number;
  complete: boolean; rate: number | null; low: number | null; high: number | null;
}
/** Official formula: validated / applicable. Undecided criteria give a range, never a silent C. */
export function rate(statuses: Status[]): Rate {
  const n = (s: Status) => statuses.filter((x) => x === s).length;
  const C = n('C'), NC = n('NC'), NA = n('NA'), BLOCKED = n('BLOCKED'), OPEN = n('OPEN');
  const u = BLOCKED + OPEN;
  const complete = u === 0 && statuses.length > 0;
  const div = (a: number, b: number) => b === 0 ? null : a / b;
  // Undecided criteria may become C, NC or NA: all NC gives the minimum, all C the maximum.
  return {
    C, NC, NA, BLOCKED, OPEN, total: statuses.length, complete,
    rate: complete ? div(C, C + NC) : null, low: div(C, C + NC + u), high: div(C + u, C + NC + u),
  };
}
