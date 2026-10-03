# runway

Budget personnel par enveloppes, inspiré d'Actual Budget, avec une prévision « reste à dépenser » à tout moment du mois, un suivi de patrimoine valorisé automatiquement et des insights (IA facultative).

Stack : TanStack Start (React) sur Cloudflare Workers, D1 + Drizzle, Effect 4.

## Démarrer en local

```sh
bun install
cp .dev.vars.example .dev.vars   # puis renseigner au moins APP_PASSWORD et SESSION_SECRET
bun run db:migrate:local
bun run dev                      # http://localhost:3000
```

Sur un budget vide, la page Budget propose de créer des catégories types, d'importer un export Actual ou de charger une démo.

### Variables (`.dev.vars` en local, secrets Wrangler en production)

| Variable | Rôle |
| --- | --- |
| `APP_PASSWORD` | Mot de passe unique de l'application (requis) |
| `SESSION_SECRET` | Chiffre le cookie de session, 32 caractères minimum (requis) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Analyse rédigée des insights et repli pour la catégorisation |
| `AI_PROVIDER` | `openai` (défaut) ou `anthropic` |
| `AI_MODEL` | Modèle du fournisseur (défaut : `gpt-6-luna` / `claude-haiku-4-5`) |
| `TYPESAFE_API_KEY` | Catégorisation et suggestions de règles via Jev (TypeSafe AI) |
| `DECISION_MODEL` | Modèle Jev (défaut : `jev-latest`) |

Sans aucune clé, tout fonctionne sauf l'analyse rédigée et les suggestions de catégories, qui affichent comment les activer.

## Tests

```sh
bun run typecheck
bun run lint
bun run test        # unitaires + intégration avec Vitest (pas `bun test`, qui lance le runner de bun)
bun run test:e2e    # Playwright, desktop puis mobile
bun run check       # tout ce qui précède
```

- Les tests d'intégration utilisent des faux modèles d'IA et des faux cours de marché : ils ne sortent jamais sur le réseau.
- `RUNWAY_LIVE_AI=1 bunx vitest run tests/integration/ai.test.ts` appelle les vrais fournisseurs (clés lues dans `.dev.vars`).
- La suite e2e démarre son propre serveur sur le port 3100 (`scripts/e2e-server.mjs`), avec une base D1 vide dans `.e2e-state`, un mot de passe connu et aucune clé d'IA. Les specs s'exécutent dans l'ordre (`01-` → `05-`, puis mobile) et partagent la base, comme un utilisateur qui enchaîne les écrans.
- Premier lancement : `bunx playwright install chromium`.

## Déployer sur Cloudflare

```sh
bunx wrangler d1 create runway          # reporter le database_id dans wrangler.jsonc
bunx wrangler secret put APP_PASSWORD
bunx wrangler secret put SESSION_SECRET
bunx wrangler secret put OPENAI_API_KEY     # facultatif, idem ANTHROPIC_API_KEY et TYPESAFE_API_KEY
bun run deploy                              # build + migrations distantes + wrangler deploy
```

`AI_PROVIDER` et `AI_MODEL` sont des variables non secrètes, dans `wrangler.jsonc`.

## Import / export

Depuis **Réglages → Données** :

- **Actual** : le `.zip` d'export d'Actual (comptes, catégories, opérations avec ventilations et virements, budget mois par mois avec reports, règles, échéances). L'export au même format est réimportable dans Actual.
- **Sauvegarde JSON** : tout Runway, patrimoine et vues enregistrées compris. Restaurer deux fois la même sauvegarde ne crée pas de doublons.
- **Fichiers bancaires** : CSV (colonnes à associer), OFX, QIF.

Les imports sont découpés en lots de 4 000 opérations et dédoublonnés ; un import de 100 000 lignes reste sous les limites des Workers et de D1.

## Sources de cotation du patrimoine

Toutes gratuites et sans clé. Si une source ne répond pas, le bien garde sa dernière estimation.

| Bien | Source | Rafraîchissement |
| --- | --- | --- |
| Crypto | CoinGecko (`/simple/price`, historique `/market_chart`) | quotidien |
| Actions, ETF, fonds | Yahoo Finance (API non officielle), converti en euros | quotidien |
| Immobilier | DVF, statistiques mensuelles par commune (data.gouv.fr), médiane au m² pondérée sur 12 mois × surface | tous les 30 jours |
| Emprunt | Tableau d'amortissement calculé (capital, taux, durée) | à la volée |
| Montres, art, véhicules… | Estimations saisies, signalées au-delà de 6 mois | — |

Les estimations automatiques sont rafraîchies à l'ouverture de la page Patrimoine, au plus une fois par jour. Les données DVF ont environ 9 mois de retard sur les ventes réelles.
