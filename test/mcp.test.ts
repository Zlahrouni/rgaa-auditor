// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the real server process with a current and an older MCP client.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as OldClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as OldTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { GuardedBrowser } from '../src/browser.ts';
import { policyFromEnv } from '../src/guard.ts';
import { axe } from '../src/probes.ts';
import { startSite, type Site } from './site.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const audits = mkdtempSync(join(tmpdir(), 'rgaa-mcp-'));
const proc = { command: process.execPath, args: [join(root, 'src/mcp.ts')], env: { ...process.env, RGAA_AUDITS: audits, RGAA_SANDBOX: '', RGAA_ALLOWED_ORIGINS: '' } as Record<string, string> };
let site: Site, c: Client, id = '';
const call = async (name: string, args: object): Promise<{ text: string; images: number; isError: boolean }> => {
  const r: any = await c.callTool({ name, arguments: args as Record<string, unknown> }, { timeout: 180_000 });
  return { text: r.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n'), images: r.content.filter((x: any) => x.type === 'image').length, isError: !!r.isError };
};
before(async () => {
  site = await startSite();
  c = new Client({ name: 'test-client', version: '1.0.0' });
  await c.connect(new StdioClientTransport(proc));
});
after(async () => { await c.close(); await site.close(); });

test('tools, limits on text sizes, and instructions', async () => {
  const { tools } = await c.listTools();
  assert.equal(tools.length, 12);
  assert.ok((c.getInstructions() ?? '').length < 4096);
  for (const t of tools) assert.ok((t.description ?? '').length < 2000);
});

test('an older MCP client works too', async () => {
  const old = new OldClient({ name: 'old', version: '1.0.0' });
  await old.connect(new OldTransport(proc));
  try {
    assert.equal((await old.listTools()).tools.length, 12);
    const r: any = await old.callTool({ name: 'glossary', arguments: { term: 'lien' } });
    assert.match(r.content[0].text, /lien/i);
  } finally { await old.close(); }
});

test('an address that was not authorised is refused', async () => {
  for (const url of ['https://example.com/', 'file:///c:/windows/win.ini', 'http://169.254.169.254/']) {
    const r = await call('audit_start', { name: 'x', pages: [{ url, name: 'x' }] });
    assert.ok(r.isError && /Not authorised/.test(r.text), url);
  }
});

test('full flow: start, collect, judge, verify, report', async () => {
  const s = await call('audit_start', { name: 'Démo', model: 'test', pages: [{ url: `${site.base}/bad`, name: 'Mauvaise' }, { url: `${site.base}/inject`, name: 'Piégée' }] });
  id = /Audit (\S+) created/.exec(s.text)![1];
  assert.ok((await call('tasks_next', { audit: id, page: 'P1' })).isError, 'no task before collecting');
  const col = await call('page_collect', { audit: id, page: 'P1' });
  assert.ok(!col.isError, col.text); assert.ok(!/Probes that failed/.test(col.text), col.text);
  const t = await call('tasks_next', { audit: id, page: 'P1', only: '1' });
  assert.match(t.text, /Test 1\.1\.1/); assert.match(t.text, /\(no alt attribute\)/); assert.match(t.text, /Method:/);

  const evidence = (kind: string) => new RegExp(`(E\\d+) ${kind}`).exec(col.text)![1];
  const bad = await call('verdict_record', { audit: id, page: 'P1', verdicts: [{ test: '1.1.1', verdict: 'C', reason: 'tout va bien ici', evidence: ['E999'] }, { test: '8.5.1', verdict: 'C', reason: 'titre présent selon moi', evidence: [evidence('inventory')] }] });
  assert.match(bad.text, /Accepted 0/); assert.match(bad.text, /unknown evidence/); assert.match(bad.text, /already proven NC/);
  const ok = await call('verdict_record', { audit: id, page: 'P1', verdicts: [{ test: '1.1.1', verdict: 'NC', reason: 'Image sans attribut alt.', evidence: [evidence('images')], elements: ['img'], impact: 'Une personne aveugle ne connaît pas le contenu.', blocking: false }] });
  assert.match(ok.text, /Accepted 1/);

  const v = await call('verify_next', { audit: id });
  assert.match(v.text, /1\.1\.1/); assert.ok(!v.text.includes('Image sans attribut alt.'), 'the first reasoning is hidden');
  await call('verify_record', { audit: id, checks: [{ page: 'P1', test: '1.1.1', outcome: 'uphold', reason: 'Vérifié sur la preuve.' }] });
  assert.match((await call('verify_next', { audit: id })).text, /No NC/);

  const pic = await call('evidence_get', { audit: id, evidence: evidence('screenshot') });
  assert.equal(pic.images, 1);
  const el = await call('element_inspect', { audit: id, page: 'P1', selector: 'img' });
  assert.match(el.text, /crop/); assert.equal(el.images, 1);
  const act = await call('page_interact', { audit: id, page: 'P1', purpose: 'essai', steps: [{ action: 'press', value: 'Tab' }] });
  assert.match(act.text, /interaction/);

  const st = JSON.parse((await call('audit_status', { audit: id })).text);
  assert.equal(st.service.total, 106); assert.equal(st.service.complete, false); assert.equal(st.service.rate, null);
  const rep = await call('report_build', { audit: id });
  assert.match(rep.text, /report\.html/);
});

test('page text cannot break out of the untrusted block', async () => {
  const r = await call('page_collect', { audit: id, page: 'P2' });
  assert.ok(!r.isError, r.text);
  for (const only of ['1', '8']) {
    const t = await call('tasks_next', { audit: id, page: 'P2', only });
    assert.equal(t.text.split('END OF UNTRUSTED PAGE DATA>>>').length, 2, `theme ${only}: exactly one end marker`);
    assert.ok(t.text.trimEnd().endsWith('END OF UNTRUSTED PAGE DATA>>>'));
  }
});

test('answers stay under the usual MCP output limit', async () => {
  for (const only of ['1', '3', '7', '8', '9', '10', '11', '12', '13']) {
    const t = await call('tasks_next', { audit: id, page: 'P1', only, limit: 10 });
    assert.ok(t.text.length < 50_000, `theme ${only}: ${t.text.length}`);
  }
});

test('no write reached the site during the whole session', () => assert.deepEqual(site.writes, []));

test('the report itself: escapes page content, states its limits, has no axe violation', async () => {
  const html = readFileSync(join(audits, id, 'report.html'), 'utf8');
  assert.match(html, /non officielle/); assert.match(html, /n’ont pas encore été mesurés/); assert.match(html, /DINUM/);
  assert.ok(!html.includes('<img'), 'nothing from the page is rendered');
  site.set('/report', html);
  const b = new GuardedBrowser(policyFromEnv({}));
  try {
    const o = await b.open(`${site.base}/report`);
    const v = (await axe(o.page)).data.results.filter((x: any) => x.kind === 'violation').map((x: any) => x.rule);
    assert.deepEqual(v, []);
    await o.close();
  } finally { await b.close(); }
});
