# runway

Budget personnel par enveloppes, inspiré d'Actual Budget, avec une prévision « reste à dépenser » à tout moment du mois, un suivi de patrimoine valorisé automatiquement et des insights (IA facultative).

Stack : TanStack Start (React) sur Cloudflare Workers, D1 + Drizzle, Effect 4. Infra décrite et déployée avec [Alchemy](https://alchemy.run) (`alchemy.run.ts`).

## Démarrer en local

```sh
bun install
cp .env.example .env   # puis renseigner au moins APP_PASSWORD et SESSION_SECRET
bun run dev            # http://localhost:3000, base D1 locale migrée au démarrage
```

`alchemy dev` simule D1 en local dans `.alchemy/local` (stage `dev_$USER`). Supprimer ce dossier repart d'une base vide.

Sur un budget vide, la page Budget propose de créer des catégories types, d'importer un export Actual ou de charger une démo.

### Variables (`.env` en local, `.env.prod` pour la production)

| Variable | Rôle |
| --- | --- |
| `APP_PASSWORD` | Mot de passe unique de l'application (requis) |
| `SESSION_SECRET` | Chiffre le cookie de session, 32 caractères minimum (requis) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Analyse rédigée des insights et repli pour la catégorisation |
| `TYPESAFE_API_KEY` | Catégorisation et suggestions de règles via Jev (TypeSafe AI) |
| `DECISION_MODEL` | Modèle Jev (défaut : `jev-latest`) |

`AI_PROVIDER` (`openai` ou `anthropic`) et `AI_MODEL` ne sont pas secrets : ils sont fixés dans `alchemy.run.ts`. Une variable facultative absente n'est pas du tout liée au Worker.

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
- `RUNWAY_LIVE_AI=1 bunx vitest run tests/integration/ai.test.ts` appelle les vrais fournisseurs (clés lues dans `.env`).
- La suite e2e démarre son propre serveur sur le port 3100 (`scripts/e2e-server.mjs`), sur le stage Alchemy `e2e`, détruit puis recréé à chaque lancement pour repartir d'une base D1 vide, avec un mot de passe connu et aucune clé d'IA. Les specs s'exécutent dans l'ordre (`01-` → `05-`, puis mobile) et partagent la base, comme un utilisateur qui enchaîne les écrans.
- Premier lancement : `bunx playwright install chromium`.

## Déployer sur Cloudflare

L'app est servie sur `runway.mtnz.app` (stage `prod`), avec une base D1 dans la juridiction `eu`. Le premier déploiement crée tout : base, Worker, domaine. Les suivants appliquent les nouvelles migrations de `drizzle/` avant de publier le Worker.

```sh
bunx alchemy profile edit --add Cloudflare   # une fois par machine ; ou CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
cp .env.example .env.prod                    # secrets de production
bun run plan                                 # aperçu des changements
bun run deploy
bun run logs                                 # logs du Worker en direct
```

- L'état d'Alchemy est stocké sur le compte Cloudflare (un Worker `alchemy-state-store`) : on peut déployer depuis n'importe quelle machine qui a les accès, mais pas deux déploiements en même temps.
- Chaque déploiement remplace tous les bindings : un secret absent de `.env.prod` est retiré du Worker. `APP_PASSWORD` et `SESSION_SECRET` manquants font échouer le déploiement.
- La base de prod est conservée même par `alchemy destroy`.
- Plan Workers gratuit : 10 ms de CPU par requête. Des erreurs 1102 dans `bun run logs` indiquent qu'il faut passer au plan payant.

## Import / export

Depuis **Réglages → Données** :

- **Actual** : le `.zip` d'export d'Actual (comptes, catégories, opérations avec ventilations et virements, budget mois par mois avec reports, règles, échéances). L'export au même format est réimportable dans Actual.
- **Sauvegarde JSON** : tout Runway, patrimoine et vues enregistrées compris. Restaurer deux fois la même sauvegarde ne crée pas de doublons.
- **Fichiers bancaires** : CSV (colonnes à associer), OFX, QIF.

Les imports sont découpés en lots de 4 000 opérations et dédoublonnés ; un import de 100 000 lignes reste sous les limites des Workers et de D1 du plan payant (le plan gratuit plafonne D1 à 100 000 lignes écrites par jour, index compris).

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
