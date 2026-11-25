// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Audit, Evidence, EvidenceKind } from './ledger.ts';

export class Store {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }

  newId(name: string): string {
    const slug = name.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'audit';
    return `${slug.replace(/-$/, '')}-${randomBytes(3).toString('hex')}`;
  }
  dir(id: string): string {
    if (!/^[a-z0-9-]{1,60}$/.test(id)) throw new Error('invalid audit id');
    return join(this.root, id);
  }
  list(): string[] { return readdirSync(this.root).filter((d) => existsSync(join(this.root, d, 'audit.json'))); }
  load(id: string): Audit {
    const f = join(this.dir(id), 'audit.json');
    if (!existsSync(f)) throw new Error(`unknown audit "${id}". Known: ${this.list().join(', ') || 'none'}`);
    return JSON.parse(readFileSync(f, 'utf8')) as Audit;
  }
  save(a: Audit): void {
    const d = this.dir(a.id);
    mkdirSync(d, { recursive: true });
    const tmp = join(d, 'audit.json.tmp');
    writeFileSync(tmp, JSON.stringify(a, null, 1));
    renameSync(tmp, join(d, 'audit.json'));
  }
  addEvidence(a: Audit, page: string, kind: EvidenceKind, label: string, data: unknown, png?: Buffer, partial?: string): Evidence {
    const id = `E${a.nextEvidence++}`;
    const d = join(this.dir(a.id), 'evidence');
    mkdirSync(d, { recursive: true });
    const e: Evidence = { id, page, kind, label, file: `${id}.json`, at: new Date().toISOString(), ...(partial ? { partial } : {}) };
    writeFileSync(join(d, e.file), JSON.stringify(data, null, 1));
    if (png) { e.image = `${id}.png`; writeFileSync(join(d, e.image), png); }
    a.evidence.push(e);
    return e;
  }
  readEvidence(a: Audit, e: Evidence): string { return readFileSync(join(this.dir(a.id), 'evidence', e.file), 'utf8'); }
  readImage(a: Audit, e: Evidence): Buffer | null { return e.image ? readFileSync(join(this.dir(a.id), 'evidence', e.image)) : null; }
}
