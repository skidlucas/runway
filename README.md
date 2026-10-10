# runway

A personal envelope budget, heavily inspired by [Actual Budget](https://actualbudget.org) ([source](https://github.com/actualbudget/actual)). It adds a "left to spend" forecast for any day of the month, net worth tracking with automatic valuations, and insights, with optional AI.

Runway follows Actual's budgeting model (envelopes, rollovers, "to budget") and stays compatible with it: an Actual export imports into Runway, and Runway exports to Actual's format. See [Import / export](#import--export) for details.

The interface is in French.

Stack: TanStack Start (React) on Cloudflare Workers, D1 + Drizzle, Effect 4. Infrastructure is described and deployed with [Alchemy](https://alchemy.run) (`alchemy.run.ts`).

## Run locally

```sh
bun install
cp .env.example .env   # then set at least APP_PASSWORD and SESSION_SECRET
bun run dev            # http://localhost:3000, the local D1 database is migrated on startup
```

`alchemy dev` emulates D1 locally in `.alchemy/local` (stage `dev_$USER`). Deleting that folder starts over from an empty database. New migrations are applied when the dev server starts: restart it after pulling a migration.

On an empty budget, the Budget page offers to create starter categories, import an Actual export or load demo data.

### Variables (`.env` locally, `.env.prod` for production)

| Variable | Purpose |
| --- | --- |
| `APP_PASSWORD` | The app's single password, at least 12 characters (required) |
| `SESSION_SECRET` | Encrypts the session cookie, at least 32 characters (required) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Written insight analysis, questions typed in Insights, reading an invoice or a screenshot into a new operation, and fallback for category suggestions |
| `TYPESAFE_API_KEY` | Category suggestions through Jev (TypeSafe AI) |
| `AI_PROVIDER` / `AI_MODEL` | Provider of the written analysis, `openai` (default) or `anthropic`, and its model (default: `gpt-6-luna` / `claude-haiku-4-5`) |
| `DECISION_MODEL` | Jev model (default: `jev-latest`) |
| `COINGECKO_API_KEY` | Free CoinGecko "Demo" key for crypto prices. Recommended in production: without it, CoinGecko limits requests per IP address, which Workers share, and often answers 429 |
| `RUNWAY_DOMAIN` | Production only: custom domain, in a zone of the same Cloudflare account. Without it, the app is served on its `*.workers.dev` address |

An optional variable that is not set is not bound to the Worker at all.

Without any AI key, everything works except the written analysis, typed questions and category suggestions, which explain how to enable them, and reading a document into a new operation, which is not offered. Categorization at import (rules, then each payee's usual category) and rule suggestions never use AI.

## Tests

```sh
bun run typecheck
bun run lint
bun run test        # unit + integration with Vitest (not `bun test`, which runs bun's own runner)
bun run test:e2e    # Playwright, desktop then mobile
bun run check       # all of the above
```

- Integration tests use fake AI models and fake market prices: they never go to the network.
- `RUNWAY_LIVE_AI=1 bunx vitest run tests/integration/ai.test.ts tests/integration/receipts.test.ts` calls the real providers, with keys read from `.env`.
- The e2e suite starts its own server on port 3100 (`scripts/e2e-server.mjs`), on the Alchemy stage `e2e`. That stage is destroyed and recreated on every run, so each run starts from an empty D1 database, with a known password and no AI key. Specs run in order (`01-` → `08-`, then mobile) and share the database, like a user moving from screen to screen.
- First run: `bunx playwright install chromium`.

## Deploy to Cloudflare

Each person deploys their own instance on their own Cloudflare account (stage `prod`), with a D1 database in the `eu` jurisdiction. It is served on `RUNWAY_DOMAIN` when set, on its `*.workers.dev` address otherwise. The first deploy creates everything: database, Worker, domain. Later deploys apply new migrations from `drizzle/` before publishing the Worker.

```sh
bunx alchemy profile edit --add Cloudflare   # once per machine; or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
cp .env.example .env.prod                    # production secrets
bun run plan                                 # preview the changes
bun run deploy
bun run logs                                 # live Worker logs
```

- Alchemy's state is stored on the Cloudflare account, in an `alchemy-state-store` Worker. Any machine with access can deploy, but not two deploys at the same time.
- Every deploy replaces all bindings: a secret missing from `.env.prod` is removed from the Worker, and so is the custom domain when `RUNWAY_DOMAIN` is missing. Deploys (and `bun run dev`) fail if `APP_PASSWORD` or `SESSION_SECRET` is missing or too short.
- The production database is kept even by `alchemy destroy`.
- GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, lint and Vitest on every push. Deploying on push can be left to Cloudflare Workers Builds with `bun run deploy:ci` as the deploy command and the variables set on the build.
- The free Workers plan allows 10 ms of CPU per request. Errors 1102 in `bun run logs` mean it is time to move to the paid plan.

## Import / export

From **Settings → Data** (*Réglages → Données*).

**Import**

- **Actual**: Actual's export `.zip` (accounts, categories, transactions with splits and transfers, the budget month by month with rollovers, rules, schedules).
- **Runway JSON backup**: all of Runway, including net worth and saved views. Restoring the same backup twice creates no duplicates.
- **Bank files**: CSV (with column mapping), OFX, QIF.

**Export**

- **JSON backup**: the complete copy, for backups or for moving to another Runway instance.
- **Actual format**: the same `.zip` as an Actual export. Import it in Actual with *Import file → Actual*. The tests load it with Actual's official API and check that balances and the budget match. It contains everything Actual can represent: accounts, categories, payees, transactions, budget, rules and schedules. What only exists in Runway is left out:
  - net worth (assets, loans, valuations, owned share);
  - saved views and dashboards;
  - account settings Actual doesn't have: account type, inclusion in the forecast, reconciliation date;
  - rules on amounts. Runway compares absolute amounts and Actual compares signed ones, so there is no faithful translation. The export reports how many rules it skipped.

Imports are split into batches of 4,000 transactions and deduplicated. A 100,000-row import stays within the Workers and D1 limits of the paid plan. The free plan caps D1 at 100,000 rows written per day, indexes included.

## Net worth valuation sources

All free. Only CoinGecko takes an (optional) key. When a source doesn't answer, the asset keeps its last estimate.

| Asset | Source | Refresh |
| --- | --- | --- |
| Crypto | [CoinGecko](https://www.coingecko.com): price, 24 h / 7-day trends and hourly week from `/coins/markets`, one year of daily history from `/market_chart` (only missing days are fetched again) | daily |
| Stocks, ETFs, funds | Yahoo Finance (unofficial API), converted to euros | daily |
| Real estate | [Statistiques DVF](https://www.data.gouv.fr/fr/datasets/64998de5926530ebcecc7b15/), monthly statistics per municipality (data.gouv.fr): 12-month weighted median price per m² × surface | every 30 days |
| Loan | Computed amortization schedule (principal, rate, term) | on the fly |
| Watches, art, vehicles… | Manual estimates, flagged after 6 months | — |

Automatic estimates are refreshed when the Net worth page opens, at most once a day. DVF data lags actual sales by about 9 months.

### Data providers' terms

- **CoinGecko**: crypto prices are *Powered by [CoinGecko](https://www.coingecko.com)*, through its public API and subject to the [CoinGecko API terms](https://www.coingecko.com/en/api_terms).
- **Yahoo Finance**: Yahoo has no official public API. The endpoints Runway uses are undocumented, for personal use only, and can change or be blocked without notice. Each instance operator is responsible for complying with Yahoo's terms.
- **Real estate**: contains information from *Statistiques DVF* (data.gouv.fr), available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).
- **Communes**: [API Découpage administratif](https://geo.api.gouv.fr) (geo.api.gouv.fr), under the [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/).

## License

[MIT](LICENSE). Runway reads and writes Actual Budget's formats and ships an empty Actual database template: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
