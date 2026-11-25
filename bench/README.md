# Exam and scoring

The exam pages and the answer key are in a **separate folder**, `../rgaa-bench`, not published in this repository, so the AI taking the exam does not see them. Do not copy them here. `score.ts` contains no answers.

Three pages with neutral names: `/a`, `/b`, `/c`. 76 scored tests (44 C, 17 NC, 15 NA); every other RGAA test is not scored. The key has **not been reviewed by an auditor**.

## Run it

1. Start the pages, from the `rgaa-bench` folder:

```powershell
node serve.mjs
```

2. In a second terminal, from the `RGAA` folder, start an AI session that only has the rgaa tools (no file or shell access). See your MCP client's documentation.

3. Ask: *Use the rgaa tools to audit http://127.0.0.1:4190/a, http://127.0.0.1:4190/b and http://127.0.0.1:4190/c in one audit, from start to report, without asking me questions. State your model name in audit_start.*

4. List the audits, then score one. Give several ids of the same AI to also get stability:

```powershell
node src/cli.ts list
```

```powershell
npm run score -- ../rgaa-bench/key.json AUDIT_ID
```

## Read the result

- Answers from the AI and direct measurements are scored **separately**.
- `BLOCKED`, unanswered and disputed failures are undecided; on a real failure they also count as missed.
- Failures reported outside the key are listed, not scored: an auditor should look.
- A NC counts as correct even if another element was cited, but it is listed to check by eye.

The sample is small, so look at the 95% range, not only the percentage. The pages are simple: **these figures are not RGAA accuracy**. After an AI or a person has tuned the agent on these pages, they no longer measure anything new.

Change answers in `rgaa-bench/make-key.py`, run it, then run `node check.mjs ../RGAA <empty folder>` there: it checks that the server can accept every answer. Set `reviewedByAuditor` to `True` only after a real review.
