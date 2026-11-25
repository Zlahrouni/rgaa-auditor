// SPDX-License-Identifier: AGPL-3.0-or-later
// Loads the official RGAA data. The engine never hard-codes the number of criteria.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

type Rich = string | { ul: string[] } | { ol: string[] };
interface RawCriterion {
  number: number; title: string; tests: Record<string, string | string[]>;
  particularCases?: Rich[]; technicalNote?: Rich[];
}
interface RawPack { topics: { topic: string; number: number; criteria: { criterium: RawCriterion }[] }[] }

export interface RgaaTest { id: string; text: string; method: string }
export interface Criterion {
  id: string; theme: number; themeName: string; title: string;
  tests: RgaaTest[]; particularCases: string; technicalNote: string;
}
export interface Pack { version: string; hash: string; criteria: Criterion[]; byId: Map<string, Criterion>; glossary: { title: string; body: string }[] }

const strip = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[  ]/g, ' ');
const rich = (r?: Rich[]) => (r ?? []).map((x) => typeof x === 'string' ? x
  : ('ul' in x ? x.ul : x.ol).join('\n')).map(strip).join('\n');

export function loadPack(version = '4.1.2'): Pack {
  const read = (f: string) => readFileSync(new URL(`../data/rgaa-${version}/${f}.json`, import.meta.url), 'utf8');
  const rawText = read('criteres');
  const raw = JSON.parse(rawText) as RawPack;
  const methods = JSON.parse(read('methodologies')) as Record<string, string>;
  const gloss = JSON.parse(read('glossaire')) as { glossary: { title: string; body: string }[] };
  const criteria: Criterion[] = [];
  for (const t of raw.topics) for (const { criterium: c } of t.criteria) {
    const id = `${t.number}.${c.number}`;
    criteria.push({
      id, theme: t.number, themeName: t.topic, title: strip(c.title),
      tests: Object.entries(c.tests).map(([n, text]) => ({
        id: `${id}.${n}`,
        text: strip(Array.isArray(text) ? text[0] + text.slice(1).map((x) => `\n- ${x}`).join('') : text),
        method: strip(methods[`${id}.${n}`] ?? ''),
      })),
      particularCases: rich(c.particularCases), technicalNote: rich(c.technicalNote),
    });
  }
  return {
    version, hash: createHash('sha256').update(rawText).digest('hex').slice(0, 12), criteria,
    byId: new Map(criteria.map((c) => [c.id, c])),
    glossary: gloss.glossary.map((g) => ({ title: g.title, body: strip(g.body.replace(/<li>/g, '\n- ').replace(/<[^>]+>/g, '')) })),
  };
}
