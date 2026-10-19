# Health Informatics Atlas

An English-first learning website with Chinese explanations for health informatics coursework. Public course reading, personal ChatGPT sign-in, and private progress and notes that sync between devices.

**Live website:** https://health-informatics-atlas-ricky.tracy-che96.chatgpt.site

A personal study companion for Applied Statistical Modelling and Health Informatics MSc coursework. It is independent of King's College London. Learning targets are suggested study goals, not an official assessment rubric.

## Learning features

- 20 lessons across Topics 1–4, with source filenames and page/cell references.
- 43 questions with explanations, 55 bilingual glossary terms, and application exercises.
- Three guided Python practicals with 20 steps and downloadable worked scripts.
- Reading progress, mastery checklists, notes, guest-record migration and JSON backups.
- Public course access; signed-in progress endpoints are restricted to the current account.

Original slides, lecture transcripts, notebooks and patient-level datasets are **not included**. The repository contains authored teaching summaries, reference code and aggregate results. Private study records live in the hosted database, not in this repository.

## Development

Requires Node.js 22.13+ and npm. The repository uses the official Sites Vinext starter and its Cloudflare D1 integration.

```sh
npm run install:ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_funny_songbird.sql
npm run dev -- --hostname 127.0.0.1
```

The local server prints its URL. Its development-only sign-in simulates `seedy@sites.test`; hosted authentication is provided by Sites. Do not expose the development server to the public internet. The login mock is excluded from production builds.

```sh
npm test
npx tsc --noEmit --incremental false
npm run build
```

## Structure

- `public/`: course data, browser UI and synchronization controller.
- `lib/site-shell.ts`: the public HTML shell served by `app/route.ts`.
- `app/api/account/`: account display and sign-in/sign-out URLs.
- `app/api/progress/`: authenticated read/write endpoints.
- `lib/progress-store.ts`: validation and database operations.
- `db/schema.ts`, `drizzle/`: schema and append-only migrations.
- `tests/`: account isolation, concurrency and sync tests.
- `.openai/hosting.json`: Sites project identity and logical database binding.

## Progress and privacy

The server derives ownership from the trusted Sites user ID. Client-supplied identity is never used as an authorization grant. Writes additionally require the queued account ID to match the current session, preventing an old account's queue from being uploaded to a newly signed-in account.

Each record has a version. Concurrent changes are detected before replacing a value. Different notes are retained until the learner chooses which version to keep. Reset operations leave versioned tombstones so an outdated device cannot silently resurrect cleared records. APIs require same-origin writes and return non-cacheable responses.

Guest progress remains local until explicitly imported. Backups can be exported from My progress. The browser keeps an account-specific pending queue for retries; sign-out does not make those records part of another account's guest state. If a tab closes before uploading, My progress offers recovery of its unsent drafts after the same account signs in again. Signing out in one open tab immediately hides account records in the other tabs and asks them to reload.

The website does not execute Python. Download the reference scripts and run them locally with the supplied course files. No analytics or external font scripts are included.

## Deployment

This site is deployed through Sites as a Worker with the `DB` D1 binding. Preserve the Sites build integration and apply schema changes through generated migrations. The hosting project ID is specific to this deployment; create a separate project before deploying a fork.

GitHub stores source code. Merely pushing here does not deploy the site, provision a database or configure hosted authentication. GitHub Pages alone cannot run the authenticated API or D1 storage.

Do not commit `.env` files, credentials, production database exports, personal progress backups, original teaching materials or patient-level data. See `.gitignore`.
