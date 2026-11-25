#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Commands reserved for a person. The AI has no access to them through MCP.
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { sessionFile } from './browser.ts';
import { originAllowed, policyFromEnv } from './guard.ts';
import { record, type Verdict } from './ledger.ts';
import { loadPack } from './pack.ts';
import { buildReport, summary } from './report.ts';
import { Store } from './store.ts';

const [cmd, ...args] = process.argv.slice(2);
const store = () => new Store(process.env.RGAA_AUDITS ?? fileURLToPath(new URL('../audits', import.meta.url)));

async function login(url: string): Promise<void> {
  if (!originAllowed(url, policyFromEnv())) throw new Error('Add this origin to RGAA_ALLOWED_ORIGINS first.');
  const b = await chromium.launch({ headless: false });
  const c = await b.newContext({ locale: 'fr-FR' });
  await (await c.newPage()).goto(url);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Log in yourself in the window, then press Enter here. ');
  rl.close();
  const f = sessionFile(url);
  await c.storageState({ path: f });
  await b.close();
  console.log(`Session saved, not encrypted: ${f}\nDelete it with: rgaa logout ${new URL(url).origin}`);
}

try {
  if (cmd === 'login' && args[0]) await login(args[0]);
  else if (cmd === 'logout' && args[0]) { const f = sessionFile(args[0]); if (existsSync(f)) rmSync(f); console.log('Session deleted.'); }
  else if (cmd === 'list') console.log(store().list().join('\n') || 'No audit.');
  else if (cmd === 'report' && args[0]) { const s = store(); console.log(buildReport(s, s.load(args[0]), loadPack())); }
  else if (cmd === 'status' && args[0]) { const s = store(); console.log(JSON.stringify(summary(s.load(args[0]), loadPack()), null, 1)); }
  else if (cmd === 'confirm' && args.length >= 5) {
    const [id, page, test, verdict, ...why] = args;
    if (!['C', 'NC', 'NA'].includes(verdict)) throw new Error('verdict must be C, NC or NA');
    const s = store(), a = s.load(id), pack = loadPack();
    if (!a.pages.some((p) => p.id === page) || !pack.criteria.some((c) => c.tests.some((t) => t.id === test))) throw new Error('unknown page or test');
    const old = a.verdicts[page]?.[test];
    record(a, page, { test, verdict: verdict as Verdict, reason: why.join(' '), evidence: old?.evidence ?? [], elements: old?.elements, impact: old?.impact, blocking: verdict === 'NC' ? old?.blocking : undefined }, 'confirmed', 'person');
    s.save(a);
    console.log(`${page} ${test} = ${verdict}, confirmed by a person.`);
  } else console.log('rgaa login <url> | logout <url> | list | status <audit> | report <audit> | confirm <audit> <page> <test> <C|NC|NA> <reason>');
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
