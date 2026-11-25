// SPDX-License-Identifier: AGPL-3.0-or-later
// Local demo pages to try the agent: /good has no planted defect, /bad and /badform have several.
import { createServer } from 'node:http';
import { PAGES } from './site.ts';
const port = Number(process.env.PORT ?? 4180);
createServer((q, r) => {
  const html = PAGES[(q.url ?? '/').split('?')[0]];
  r.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  r.end(html ?? 'not found');
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/bad  /badform  /good  (Ctrl+C to stop)`));
