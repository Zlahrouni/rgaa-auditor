// SPDX-License-Identifier: AGPL-3.0-or-later
// French report. The limits come first, the rate is always labelled as an estimate.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_INSTRUMENT, criterionOf, pageStatus, rate, serviceStatus, testStatus, type Audit, type Status, type TestVerdict } from './ledger.ts';
import type { Pack } from './pack.ts';
import type { Store } from './store.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LABEL: Record<Status, string> = { C: 'Conforme', NC: 'Non conforme', NA: 'Non applicable', BLOCKED: 'Non examinable', OPEN: 'Non décidé' };
const pct = (x: number | null) => x === null ? '—' : `${(x * 100).toFixed(1).replace('.', ',')} %`;
const CONF: Record<string, string> = { proven: 'mesure directe', unmeasured: 'avis de l’IA, fiabilité non mesurée', confirmed: 'confirmé par une personne' };

export function summary(a: Audit, pack: Pack) {
  const service = rate(pack.criteria.map((c) => serviceStatus(a, c)));
  const pages = a.pages.map((p) => ({ id: p.id, name: p.name, url: p.url, collected: p.collected, ...rate(pack.criteria.map((c) => pageStatus(a, c, p.id))) }));
  const all = a.pages.flatMap((p) => Object.values(a.verdicts[p.id] ?? {}));
  return {
    audit: a.id, name: a.name, rgaa: a.pack, service, pages,
    verdicts: { total: all.length, proven: all.filter((v) => v.confidence === 'proven').length, unmeasured: all.filter((v) => v.confidence === 'unmeasured').length, confirmed: all.filter((v) => v.confidence === 'confirmed').length,
      ncWaitingForSecondCheck: all.filter((v) => v.verdict === 'NC' && v.confidence === 'unmeasured' && !v.check).length, disputed: all.filter((v) => v.check && v.check.outcome !== 'uphold').length,
      blockingProblems: all.filter((v) => testStatus(v) === 'NC' && v.blocking).length },
  };
}

export function buildReport(store: Store, a: Audit, pack: Pack): { html: string; json: string; csv: string } {
  const s = summary(a, pack);
  const ev = (ids: string[]) => ids.map((id) => {
    const e = a.evidence.find((x) => x.id === id);
    return e ? `<a href="evidence/${esc(e.image ?? e.file)}">${esc(id)}<span class="sr"> (${esc(e.kind)}, page ${esc(e.page)})</span></a>` : esc(id);
  }).join(', ');
  const card = (p: string, v: TestVerdict) => `<li><h4>Test ${esc(v.test)}, page ${esc(p)}${v.blocking ? ' — <strong>bloquant</strong>' : ''}</h4>
<p>${esc(v.reason)}</p><dl><dt>Éléments</dt><dd>${(v.elements ?? []).map((x) => `<code>${esc(x)}</code>`).join(' ')}</dd><dt>Conséquence</dt><dd>${esc(v.impact)}</dd>
<dt>Preuves</dt><dd>${ev(v.evidence)}</dd><dt>Fiabilité</dt><dd>${esc(CONF[v.confidence])}${v.check ? ` ; seconde vérification : ${{ uphold: 'maintenu', refute: 'contesté', unsure: 'incertain' }[v.check.outcome]}` : v.confidence === 'unmeasured' ? ' ; pas de seconde vérification' : ''}</dd></dl></li>`;
  const ncByCriterion = pack.criteria.map((c) => ({ c, list: a.pages.flatMap((p) => Object.values(a.verdicts[p.id] ?? {}).filter((v) => criterionOf(v.test) === c.id && testStatus(v) === 'NC').map((v) => card(p.id, v))) })).filter((x) => x.list.length);
  const open = pack.criteria.filter((c) => ['OPEN', 'BLOCKED'].includes(serviceStatus(a, c)));
  const why = (id: string) => {
    const vs = a.pages.flatMap((p) => Object.values(a.verdicts[p.id] ?? {}).filter((v) => criterionOf(v.test) === id));
    const blocked = vs.find((v) => v.verdict === 'BLOCKED');
    return vs.some((v) => v.check && v.check.outcome !== 'uphold') ? 'Deux vérifications en désaccord' : blocked ? blocked.reason : NO_INSTRUMENT[id] ? `Instrument absent : ${NO_INSTRUMENT[id]}` : 'Pas encore jugé';
  };
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Évaluation RGAA assistée : ${esc(a.name)}</title>
<style>body{font:1rem/1.5 system-ui,sans-serif;max-width:70rem;margin:0 auto;padding:1rem;color:#1a1a1a;background:#fff}a{color:#0b4f9e}.warn{border-left:.4rem solid #a33;padding:.5rem 1rem;background:#fdf3f2}table{border-collapse:collapse;width:100%}th,td{border:1px solid #767676;padding:.35rem .6rem;text-align:left;vertical-align:top}caption{text-align:left;font-weight:bold;padding:.4rem 0}code{background:#eee;padding:0 .2rem;overflow-wrap:anywhere}.NC{font-weight:bold;color:#9c1c1c}.scroll{overflow-x:auto}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}dt{font-weight:bold}dd{margin:0 0 .4rem}li{margin-bottom:1rem}.skip{position:absolute;left:-999rem}.skip:focus{position:static}</style></head>
<body><a class="skip" href="#main">Aller au contenu</a><main id="main" tabindex="-1"><h1>Évaluation RGAA ${esc(a.pack)} assistée : ${esc(a.name)}</h1>
<section class="warn" aria-labelledby="lim"><h2 id="lim">À lire avant les résultats</h2><ul>
<li>Ce document n’est <strong>pas un audit de conformité certifié</strong>. Le taux est une <strong>estimation, non officielle</strong>.</li>
<li>L’outil commet des erreurs : fausses alertes, défauts manqués et « conforme » à tort. <strong>Leurs taux n’ont pas encore été mesurés.</strong></li>
<li>Verdicts : ${s.verdicts.proven} par mesure directe, ${s.verdicts.unmeasured} par IA ou par le moteur sans fiabilité mesurée, ${s.verdicts.confirmed} confirmés par une personne. ${s.verdicts.ncWaitingForSecondCheck} non-conformités n’ont pas eu de seconde vérification.</li>
<li>IA utilisée (déclarée par le client, non vérifiée) : ${esc(a.model || 'inconnue')}.</li>
<li>Aucun lecteur d’écran réel n’a été utilisé. Seul le contenu des états visités a été examiné.</li></ul></section>
<h2>Résultat estimé</h2>
<p>${s.service.complete ? `Taux estimé : <strong>${pct(s.service.rate)}</strong>` : `Taux estimé entre <strong>${pct(s.service.low)}</strong> et <strong>${pct(s.service.high)}</strong> : ${s.service.OPEN + s.service.BLOCKED} critères sur ${s.service.total} ne sont pas décidés, la formule officielle ne peut donc pas être complétée.`} Problèmes signalés comme bloquants : ${s.verdicts.blockingProblems}.</p>
<div class="scroll" role="region" aria-label="Résultats par page" tabindex="0"><table><caption>Critères par page</caption><thead><tr><th scope="col">Page</th><th scope="col">Conformes</th><th scope="col">Non conformes</th><th scope="col">Non applicables</th><th scope="col">Non examinables</th><th scope="col">Non décidés</th></tr></thead><tbody>
${s.pages.map((p) => `<tr><th scope="row">${esc(p.id)} ${esc(p.name)}<br><code>${esc(p.url)}</code></th><td>${p.C}</td><td>${p.NC}</td><td>${p.NA}</td><td>${p.BLOCKED}</td><td>${p.OPEN}</td></tr>`).join('')}</tbody></table></div>
<h2>Non-conformités</h2>${ncByCriterion.length ? ncByCriterion.map((x) => `<h3>${esc(x.c.id)} ${esc(x.c.title)}</h3><ul>${x.list.join('')}</ul>`).join('') : '<p>Aucune non-conformité retenue. Cela ne prouve pas la conformité.</p>'}
<h2>Critères non décidés</h2>${open.length ? `<ul>${open.map((c) => `<li><strong>${esc(c.id)}</strong> ${esc(c.title)}<br>${esc(why(c.id))}</li>`).join('')}</ul>` : '<p>Aucun.</p>'}
<h2>Grille</h2><div class="scroll" role="region" aria-label="Grille des critères" tabindex="0"><table><caption>Statut des ${pack.criteria.length} critères</caption><thead><tr><th scope="col">Critère</th><th scope="col">Ensemble</th>${a.pages.map((p) => `<th scope="col">${esc(p.id)}</th>`).join('')}</tr></thead><tbody>
${pack.criteria.map((c) => { const st = serviceStatus(a, c); return `<tr><th scope="row">${esc(c.id)} <span>${esc(c.title)}</span></th><td class="${st}">${LABEL[st]}</td>${a.pages.map((p) => { const x = pageStatus(a, c, p.id); return `<td class="${x}">${LABEL[x]}</td>`; }).join('')}</tr>`; }).join('')}</tbody></table></div>
<h2>Sources</h2><p>Critères : DINUM, RGAA ${esc(a.pack)}, <a href="https://github.com/DISIC/accessibilite.numerique.gouv.fr/tree/main/RGAA">données sources</a> (mise à jour du 7 janvier 2026), Licence Ouverte 2.0. Outil indépendant, ni affilié à la DINUM ni approuvé par elle. ${esc(a.tool)}, audit ${esc(a.id)} créé le ${esc(a.created.slice(0, 10))}.</p></main></body></html>`;
  const dir = store.dir(a.id);
  const out = { html: join(dir, 'report.html'), json: join(dir, 'report.json'), csv: join(dir, 'grid.csv') };
  const cell = (x: string) => `"${(/^[=+\-@]/.test(x) ? `'${x}` : x).replace(/"/g, '""')}"`;
  writeFileSync(out.html, html);
  writeFileSync(out.json, JSON.stringify({ ...s, warning: 'Estimate, not official. Error rates not measured.', criteria: pack.criteria.map((c) => ({ id: c.id, status: serviceStatus(a, c) })), verdicts: a.verdicts }, null, 1));
  writeFileSync(out.csv, '﻿' + [['Critère', 'Intitulé', 'Ensemble', ...a.pages.map((p) => p.id)].map(cell).join(';'), ...pack.criteria.map((c) => [c.id, c.title, serviceStatus(a, c), ...a.pages.map((p) => pageStatus(a, c, p.id))].map(cell).join(';'))].join('\r\n'));
  return out;
}
