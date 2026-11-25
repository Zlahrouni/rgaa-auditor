// SPDX-License-Identifier: AGPL-3.0-or-later
// One guarded browser. Every request goes through guard.decide().
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decide, originAllowed, type Policy } from './guard.ts';
import { installLib } from './pagelib.ts';

export interface Opened { page: Page; blocked: string[]; events: string[]; response: { status: number; html: string } | null; close(): Promise<void> }
export interface OpenOptions { width?: number; height?: number; scale?: number }

/** Login sessions stay in the user's profile, outside the project. They are not encrypted by this version. */
export function sessionFile(origin: string): string {
  const base = process.env.RGAA_SESSIONS ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'rgaa-auditor', 'sessions');
  mkdirSync(base, { recursive: true });
  return join(base, `${new URL(origin).origin.replace(/[^a-z0-9]+/gi, '_')}.json`);
}

export class GuardedBrowser {
  private browser: Browser | null = null;
  readonly policy: Policy;
  constructor(policy: Policy) { this.policy = policy; }

  async raw(headless = true): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = await chromium.launch({ headless, args: ['--enable-blink-features=ComputedAccessibilityInfo'] });
    return this.browser;
  }
  async close(): Promise<void> { await this.browser?.close(); this.browser = null; }

  async open(url: string, o: OpenOptions = {}): Promise<Opened> {
    if (!originAllowed(url, this.policy)) throw new Error(`Not authorised: ${url}. A person must add its origin to RGAA_ALLOWED_ORIGINS.`);
    const b = await this.raw();
    const session = sessionFile(url);
    const context: BrowserContext = await b.newContext({
      viewport: { width: o.width ?? 1280, height: o.height ?? 900 }, deviceScaleFactor: o.scale ?? 1, locale: 'fr-FR',
      serviceWorkers: 'block', acceptDownloads: false, ...(existsSync(session) ? { storageState: session } : {}),
    });
    const blocked: string[] = [], events: string[] = [];
    await context.addInitScript(installLib);
    let main: Page | null = null;
    await context.route('**/*', async (route) => {
      const r = route.request();
      const nav = r.isNavigationRequest();
      let mainNavigation = false;
      try { mainNavigation = nav && r.frame().parentFrame() === null; } catch { mainNavigation = nav; }
      const d = decide({ url: r.url(), method: r.method(), mainNavigation }, this.policy);
      if (d.allow) return route.continue();
      blocked.push(`${r.method()} ${r.url().slice(0, 200)} — ${d.why}`);
      // 204 keeps the current document; abort would replace it with a browser error page.
      return mainNavigation ? route.fulfill({ status: 204 }) : route.abort('blockedbyclient');
    });
    // Sockets look connected but nothing is sent, so they cannot be used to write.
    await context.routeWebSocket(/.*/, (ws) => { events.push(`websocket not connected: ${ws.url().slice(0, 120)}`); });
    const page = await context.newPage();
    main = page;
    page.on('dialog', (d) => { events.push(`${d.type()} dialog: ${d.message().slice(0, 200)}`); void d.dismiss().catch(() => {}); });
    page.on('download', (d) => { events.push(`download cancelled: ${d.suggestedFilename()}`); void d.cancel().catch(() => {}); });
    context.on('page', (p) => { if (p !== main) { events.push(`new window opened: ${p.url() || '(blank)'}`); void p.close().catch(() => {}); } });
    page.on('pageerror', (e) => { if (events.length < 40) events.push(`script error: ${e.message.slice(0, 160)}`); });
    let response: Opened['response'] = null;
    try {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
      if (res) response = { status: res.status(), html: (await res.text().catch(() => '')).slice(0, 2_000_000) };
    } catch (e) {
      await context.close();
      throw new Error(`Could not load ${url}: ${(e as Error).message.split('\n')[0]}`);
    }
    await settle(page);
    if (!originAllowed(page.url(), this.policy)) { const u = page.url(); await context.close(); throw new Error(`The page left the authorised origins (${u}). Is a login needed?`); }
    return { page, blocked, events, response, close: () => context.close() };
  }
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(250);
}
