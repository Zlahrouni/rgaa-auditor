# rgaa-auditor

> **Status: first prototype (0.1). It runs as an MCP server. Accuracy has not been measured.**

Audits web pages against the French RGAA 4.1.2 (106 criteria, 258 tests). The AI you already use (in any MCP client) does the judging, so **no API key is needed**. This server measures the page, stores proof, and refuses verdicts without proof. It never modifies your code.

## Can I trust the result?

**Not blindly.** It makes three kinds of errors:

| Error | Meaning | Our measured rate |
|---|---|---|
| False positive | Reports a failure that is not one | **Not measured yet** |
| Missed failure | Does not find a real failure | **Not measured yet** |
| Wrong "compliant" | Says a criterion passes when it fails | **Not measured yet** |

**For comparison only:** for a similar research system, [InterA11y](https://github.com/jszh/InterA11y), figures recalculated from its published predictions are: with four AIs on 197 elements and 10 WCAG criteria, 6-8% of reported failures were false positives and 16-23% of real failures were missed. Those are **not** our results.

- The result is an assisted estimate, **not a certified audit**, not an official rate, and not legal advice.
- Results depend on the AI. The report names the AI only as declared by the client. No AI is recommended yet.
- Content of the audited page (text, HTML, pictures) goes to the AI you use. Audit test data, not real personal data.

## Try it

Needs Node 22.18+ and Playwright's Chromium revision 1254.

```powershell
npm install --ignore-scripts
```

```powershell
npx playwright-core install chromium
```

Create your local configuration:

```powershell
Copy-Item mcp.example.json .mcp.json
```

Start the demo pages in one terminal:

```powershell
npm run demo
```

Then open a **new** AI session in this folder, approve the `rgaa` server, and ask:

> Use the rgaa tools to audit http://127.0.0.1:4180/badform from start to report, without asking me questions.

Use a session for auditing only, without other tools where possible: a hostile page could try to give your AI instructions. For another MCP client, register the command `node <this folder>/src/mcp.ts`. Automated tests use two generic MCP clients; no commercial client has been tested end to end yet.

Reports are written to `audits/<id>/report.html`, with a JSON file and a CSV grid.

## Audit your own app

Set these in `.mcp.json`. Only a person sets them; the AI cannot.

| Variable | Effect |
|---|---|
| `RGAA_ALLOWED_ORIGINS` | Extra sites you may audit, e.g. `https://test.example.fr`. Local addresses always work. **List only sites you own or have permission to audit** |
| `RGAA_SANDBOX=1` | Lets forms really submit, on local addresses only. Use with fake data |
| `RGAA_ALLOW_WRITES` | Exact exceptions, separated by `;`, e.g. `POST http://localhost:3000/graphql` |

By default every write request is blocked, WebSockets are not connected, outside navigation is stopped, and buttons that look irreversible are not pressed. A GET link with side effects and an innocent name can still be followed, so use a test environment. Server-side form messages are only seen in sandbox mode.

Login: run `node src/cli.ts login http://localhost:3000`, log in yourself, then press Enter. The session is saved in your Windows profile, **not encrypted**; remove it with `logout`. Evidence in `audits/` is not encrypted either.

Other commands for a person: `list`, `status`, `report`, and `confirm` to validate a verdict.

## What this version does

- Direct measurement, without AI, for doctype, language, page title, frame titles, duplicate ids, and criteria with no target on the page.
- Probes: Tab walk and traps, focus visibility, 320 px, 200% text, text spacing, styles off, form errors, pictures, axe.
- Everything else is judged by the AI from the official text and the evidence.
- A second look tries to refute each failure.

**It cannot conclude "compliant" for 13 criteria** where it has no instrument: 4.2, 4.4, 4.6, 4.13, 7.1, 7.5, 8.2, 13.1, 13.3, 13.4, 13.7, 13.10, 13.12. Partial measurements cannot conclude "compliant" either. So this version will rarely give a single final rate; it gives a range.

Not included yet: real screen reader, HTML validator, media and document checks, automatic choice of pages, recorded multi-step procedures, masking, API-key mode, measured accuracy.

## Tests

```powershell
npm test
```

The tests use pages with planted defects. They show that the instruments work; **they do not measure RGAA accuracy**.

## Documents

[Exam and scoring](bench/README.md)

## Licence and sources

Code: **AGPL-3.0-or-later** ([LICENSE](LICENSE)). RGAA data in `data/` is not covered by it: **DINUM, RGAA 4.1.2**, [source](https://github.com/DISIC/accessibilite.numerique.gouv.fr/tree/main/RGAA), [Licence Ouverte 2.0](https://github.com/etalab/licence-ouverte/blob/master/LO.md), criteria last updated 7 January 2026 ([details](data/rgaa-4.1.2/SOURCE.md)). Dependencies: Playwright and the MCP SDK (Apache-2.0), axe-core (MPL-2.0), zod and pngjs (MIT).

Independent project, **not affiliated with or endorsed by DINUM or the French State**.
