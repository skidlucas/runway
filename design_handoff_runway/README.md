# Handoff : Runway, app web de budget personnel

## Vue d'ensemble
Runway est une app web responsive (desktop + mobile) de budget personnel, pour un utilisateur seul. Elle fonctionne comme Actual Budget (budget par enveloppes : chaque euro reçu est réparti dans des catégories), avec moins de fonctionnalités et des parcours simplifiés. Elle y ajoute quatre modules : prévision (« reste prévu »), insights, patrimoine et import/export Actual.

Langue de l'interface : français. Devise : €. Format des nombres : `fr-FR` (`2 840,00 €`, signe moins typographique `−`).

## À propos des fichiers de design
Les fichiers de `designs/` sont des **références de design en HTML** : des maquettes qui montrent le rendu et le comportement attendus. Ce n'est pas du code de production à reprendre tel quel. Il faut **recréer ces écrans** dans la stack choisie pour le projet. Recommandation si rien n'existe encore : React + TypeScript (Vite ou Next), CSS Modules ou Tailwind configuré avec les tokens ci-dessous, et Radix UI pour les primitives accessibles (dialog, popover, menu).

Pour ouvrir les maquettes, servir le dossier `designs/` en local (`npx serve designs`) puis ouvrir un fichier `.dc.html`. Les fichiers ont besoin de `support.js` et de `budget-data.js`, placés à côté.

## Fidélité
**Haute fidélité** pour la direction visuelle (couleurs, typo, densité, bordures, rayons) : la reproduire fidèlement.
Les données, les libellés secondaires et le nombre exact de lignes sont illustratifs. Seuls les écrans clés sont maquettés : les états vides, les erreurs et le chargement sont à dériver des mêmes règles (voir « Interactions »).

## Direction visuelle : « Précision »
C'est un outil de travail, sombre par défaut. Petite taille de texte (13 px sur desktop), bordures très fines, un seul accent indigo, montants en police mono à chiffres tabulaires. Pas de dégradés, pas d'ombres sur les surfaces (seules les fenêtres modales en ont). On doit pouvoir tout faire au clavier (palette ⌘K). Les animations sont courtes et nettes.

- Desktop : thème sombre par défaut.
- Mobile : maquetté en clair. Les deux thèmes doivent exister sur les deux formats, avec un réglage Système / Clair / Sombre.

## Design tokens

### Couleurs, thème sombre
| Token | Valeur | Usage |
|---|---|---|
| `bg` | `#0e0f11` | fond de l'app |
| `bg-sidebar` | `#0b0c0d` | barre latérale |
| `bg-panel` | `#111215` | panneau de détail à droite |
| `bg-elevated` | `#16171a` | modales, popovers |
| `bg-row-group` | `rgba(255,255,255,0.025)` | ligne de groupe de catégories |
| `bg-hover` / `bg-active` | `rgba(255,255,255,0.04)` / `rgba(255,255,255,0.06)` | survol / élément de navigation actif |
| `border` | `rgba(255,255,255,0.06)` | séparateurs principaux |
| `border-subtle` | `rgba(255,255,255,0.04)` | séparateurs entre lignes |
| `border-control` | `rgba(255,255,255,0.10)` à `0.12` | boutons secondaires, puces de filtre |
| `text` | `#e6e7ea` | texte principal |
| `text-2` | `#c3c6cc` | texte secondaire fort |
| `text-3` | `#9ba0a9` | navigation inactive |
| `text-muted` | `#8a8f98` | métadonnées |
| `text-faint` | `#6b707a` | libellés de colonnes, aides |

### Couleurs, thème clair
| Token | Valeur |
|---|---|
| `bg` | `#fbfbfc` |
| `bg-subtle` (champs, clavier, contrôle segmenté) | `#f0f0f3` |
| `border` | `#ececef` |
| `border-strong` | `#c9cad0` |
| `text` | `#17181b` |
| `text-muted` | `#6b707a` |
| `text-faint` | `#8a8f98` |

### Accent et couleurs sémantiques (communes aux deux thèmes)
| Token | Valeur | Usage |
|---|---|---|
| `accent` | `oklch(0.62 0.17 275)` | indigo : action principale, sélection, barres du mois en cours |
| `accent-soft-bg` | `oklch(0.62 0.17 275 / 0.14)` + bordure `/ 0.35` | puces « À budgéter », « Fin de mois » |
| `accent-text-dark` | `#b8bdf5` | texte sur `accent-soft-bg` en sombre |
| `positive` | sombre `oklch(0.80 0.13 155)`, clair `oklch(0.50 0.13 155)` | disponible > 0, revenus |
| `positive-bg` | `oklch(0.72 0.14 155 / 0.13)` | pastille « disponible » |
| `negative` | sombre `oklch(0.78 0.13 25)`, clair `oklch(0.55 0.17 25)` | dépassement |
| `negative-bg` | `oklch(0.68 0.16 25 / 0.16)` | pastille « dépassement » |
| `warning` | `oklch(0.82 0.12 70)` sur fond `oklch(0.75 0.14 70 / 0.10–0.14)` | hors budget, doublons, alertes |
| Graphiques, séries secondaires | `oklch(0.72 0.14 155)`, `oklch(0.75 0.14 70)`, `oklch(0.70 0.12 220)`, `#8a8f98` | répartition du patrimoine |
| Barres inactives | sombre `rgba(255,255,255,0.14)`, clair `#dcdde3` | |

### Typographie
- **Geist** (400, 500, 600) pour l'interface. **Geist Mono** (400, 500) pour tous les montants, dates courtes et raccourcis clavier. Sources : Google Fonts ou le paquet npm `geist`.
- Montants : toujours en Geist Mono, avec `font-variant-numeric: tabular-nums`, alignés à droite dans les tableaux.

| Rôle | Desktop | Mobile |
|---|---|---|
| Texte de base | 13 px / 400 | 15 px / 400 |
| Libellés de colonnes, métadonnées | 12 px, couleur `text-faint` | 12–13 px |
| Petits libellés (sections de la barre latérale, sources) | 11 px / 500 | 11 px |
| Montants dans les tableaux | Mono 12 px | Mono 13–14 px |
| Chiffres clés (KPI) | Mono 18–24 px / 400 | — |
| Grand chiffre d'écran | Mono 30 px / 500, `letter-spacing -0.02em` | Mono 32–44 px / 500, `-0.02` à `-0.03em` |
| Saisie du montant | — | Mono 52 px / 500, `-0.03em`, symbole € en `#a3a7ae` |
| Titre de modale | 15 px / 500 | 15 px / 600 |

### Espacement, rayons, ombres
- Échelle d'espacement : 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32 px.
- Marge intérieure du contenu desktop : 20 px. Mobile : 20 px.
- Hauteurs : barre du haut desktop 48 px ; en-tête de tableau 34 px ; ligne de catégorie 36 px ; ligne de groupe 34 px ; ligne d'actif 46 px ; ligne d'opération mobile environ 58 px (marge verticale 11 px) ; barre d'onglets mobile 84 px (zone sûre comprise) ; touche du clavier mobile 50 px.
- Barre latérale desktop : 232 px. Panneau de détail : 340–360 px.
- Rayons : 4 (raccourci clavier), 5 (pastilles, petit logo), 6 (boutons, éléments de navigation, puces), 8 (champs, encadrés), 10 (groupes de champs, zone de dépôt), 12 (modales, cartes mobiles, fenêtre de l'app).
- Ombres : aucune sur les surfaces. Modale : `0 30px 80px rgba(0,0,0,0.5)`. Fond derrière une modale : `rgba(5,6,8,0.6)`.

## Logo
Logotype retenu (option 3e) : le mot « runway » en minuscules, Geist 600, `letter-spacing -0.04em`, suivi d'un tiret indigo `oklch(0.68 0.16 275)`. Le tiret est aligné sur la ligne de base, avec 3 px d'écart.
- Barre latérale : 16 px, tiret de 7 × 3 px, rayon 1 px.
- Grande taille : 48 px, tiret de 22 × 7 px, rayon 2 px.
- Icône d'app et favicon : un « r » minuscule blanc et le tiret indigo sur un carré `#17181b` (rayon 28/120, soit environ 23 %). Voir `designs/Logos Runway.dc.html`, option 3e.

## Navigation
**Desktop** : barre latérale contenant le logotype, un raccourci `⌘K`, la navigation (Budget, Prévision, Insights, Patrimoine), la section « Comptes » (nom et solde en mono 12 px `text-muted`) et Réglages en bas. Barre du haut : fil d'Ariane `Section / Mois` à gauche, puces d'état à droite.

**Mobile** : barre d'onglets en bas avec Accueil (prévision), Budget, Comptes, Insights et Plus (Patrimoine, Réglages). Un bouton flottant ou un geste ouvre la saisie d'une opération. Les maquettes montrent des onglets légèrement différents d'un écran à l'autre : c'est la liste ci-dessus qui fait foi.

Les deux puces **« Reste à dépenser »** et **« Fin de mois »** restent affichées dans la barre du haut desktop sur tous les écrans liés au budget. Sur mobile, elles sont sur l'écran Accueil.

## Écrans

### 1. Budget mensuel (desktop) : `Piste A - Precision.dc.html`
- Barre du haut : `Budget / ‹ Octobre 2026 ›` (les flèches changent de mois) et la puce accent « À budgéter 312,40 € ».
- Bandeau de 3 KPI (Revenus, Budgété, Dépensé), séparés par des bordures verticales. Libellé 12 px `text-faint`, valeur en mono 18 px.
- Tableau de 4 colonnes : `1fr 140px 140px 140px` (Catégorie, Budgété, Dépensé, Disponible).
  - Ligne de groupe : fond `bg-row-group`, poids 500, totaux du groupe.
  - Ligne de catégorie : retrait à gauche de 36 px. « Disponible » est une pastille (mono 12 px, marge 2 × 8 px, rayon 5) en vert si > 0, en rouge si < 0, en gris neutre si = 0.
- La cellule « Budgété » se modifie directement dans le tableau (au clic ou avec Entrée). Tab passe à la ligne suivante. La valeur peut être une formule simple (`=120+30`).

### 2. Opérations d'un compte (mobile) : `Piste A`, premier téléphone
En-tête avec le nom du compte (13 px `text-muted`), le solde en mono 32 px et un champ de recherche (36 px de haut, fond `bg-subtle`, rayon 8). La liste affiche le bénéficiaire en 500, puis `date · catégorie` en 12 px, et le montant en mono à droite (vert pour un revenu). Glisser une ligne vers la gauche donne accès à Catégoriser et Supprimer.
Sur desktop, l'équivalent est un tableau Date / Bénéficiaire / Catégorie / Montant / Solde, avec la même grammaire visuelle que le budget, modifiable directement dans les cellules.

### 3. Saisie d'une opération (mobile) : `Piste A`, deuxième téléphone
Fenêtre plein écran : Annuler, titre « Nouvelle opération », OK (en accent). Contrôle segmenté Dépense / Revenu. Montant en mono 52 px. Groupe de champs : Bénéficiaire, Catégorie (avec le disponible restant en vert à côté), Compte, Date. Clavier numérique maison, 3 × 4 touches (`1–9 , 0 ⌫`), touches blanches sur fond `bg-subtle`.
- Le bénéficiaire propose une catégorie automatiquement, d'après la dernière utilisée pour lui.
- Le montant restant de la catégorie se met à jour pendant la saisie.

### 4. Rapports (mobile) : `Piste A`, troisième téléphone
« Dépenses · octobre », total en mono 32 px, écart avec le mois précédent. Histogramme sur 6 mois (mois en cours en accent, autres mois en barres inactives). Liste par catégorie avec une barre de 4 px.

### 5. Prévision, le « reste prévu » : `A2 - Prevision.dc.html`
- **Reste à dépenser** = Σ(budgété − dépensé) des catégories de dépense du mois, en ne comptant que les valeurs positives.
- **Solde projeté en fin de mois** = solde des comptes courants − reste à dépenser − échéances à venir non couvertes par une catégorie.
- **Par jour** = reste à dépenser ÷ jours restants dans le mois, aujourd'hui compris.
- Desktop : les 3 KPI, puis un histogramme jour par jour sur 31 barres (passé en `text-2`, futur en accent à 45 %, jours d'échéance en accent à 85 %), puis la liste des échéances avec une étiquette « Hors budget » (warning) ou le nom de la catégorie.
- Mobile (Accueil) : reste à dépenser en mono 44 px, barre de progression, 2 tuiles (Par jour, Fin de mois), section « À surveiller » (catégories en dépassement ou au-delà de 80 %), prochaines échéances.
- Les échéances viennent des opérations récurrentes (planifiées). Une détection automatique des prélèvements récurrents est souhaitable.

### 6. Insights : `A2 - Insights.dc.html`
- Une barre de requête en puces de filtre : **Mesure** (dépenses ou revenus) · **Catégorie, groupe ou bénéficiaire** · **Période** (3, 6 ou 12 mois, ou personnalisée) · **Moyenne glissante** (aucune, 3, 6 ou 12 mois). Les combinaisons peuvent être enregistrées en « vues » dans la barre latérale.
- 3 KPI : mois en cours, moyenne glissante, projection en fin de mois (linéaire au prorata des jours écoulés, en rouge si elle dépasse le budget).
- Histogramme sur 12 mois avec la moyenne glissante en ligne pointillée warning.
- Tableau « par bénéficiaire » : nom, barre, total, nombre d'opérations.
- Panneau « Constats du mois » : phrases générées par des règles locales (pas d'IA nécessaire), chacune avec une pastille de couleur et une ligne de contexte. Règles de départ :
  1. Une catégorie projetée au-dessus de son budget ou de sa moyenne 6 mois (+X %).
  2. Une catégorie nettement en dessous de la même date le mois précédent.
  3. Un nouveau prélèvement récurrent détecté.
  4. Le top des bénéficiaires du mois.
  5. Une catégorie en dépassement N mois de suite.
- Mobile : flux vertical des constats, précédé d'une carte mise en avant en `#17181b`.

### 7. Patrimoine : `A2 - Patrimoine.dc.html`
- En-tête : patrimoine net en mono 30 px, évolution sur 12 mois, barre de répartition segmentée de 8 px (écart de 2 px) avec sa légende.
- Tableau : Bien (nom et type) · Achat · Déclarée · Estimée (valeur avec sa **source et sa date** en dessous, en vert si elle est mise à jour automatiquement, en gris si elle est saisie à la main).
- Panneau de détail (340 px) : valeur retenue, plus-value depuis l'achat, les 3 valeurs avec leur date (celle retenue est surlignée en `accent / 0.10`), historique de l'estimation sur 12 mois, informations libres.
- Modèle d'un actif : `{ id, nom, type (immobilier, placement, véhicule, montre, art, autre), passif: bool, achat {montant, date}, declaree {montant, date}, estimations [{montant, date, source}], valeurRetenue: 'achat' | 'declaree' | 'estimee', notes }`. Les comptes du budget apparaissent automatiquement (en lecture seule).
- Faisabilité des estimations automatiques :
  - Placements : API de cours.
  - Immobilier : données publiques DVF (prix au m² du quartier × surface).
  - Véhicules et montres : pas d'API publique gratuite fiable. Prévoir un connecteur optionnel (service de cote payant), sinon une saisie manuelle avec rappel périodique.
  - L'app doit toujours fonctionner sans estimation automatique.

### 8. Import / export Actual : `A2 - Import Export.dc.html` (desktop uniquement)
- Réglages > Données. Une zone de dépôt (bordure pointillée `rgba(255,255,255,0.18)`, 120 px de haut, rayon 10) accepte `.zip` (Actual), `.ofx`, `.qif` et `.csv`.
- Après le dépôt, une modale d'aperçu (520 px) détecte le budget Actual et liste ce qui sera importé, avec des cases à cocher et le nombre d'éléments : comptes, catégories et groupes, opérations, historique du budget, bénéficiaires, règles. Les doublons (même date, montant et bénéficiaire) sont signalés en warning et ignorés. Le bouton principal indique le nombre d'éléments : « Importer 3 800 opérations ».
- Export : format Actual (.zip réimportable), CSV (opérations) et JSON complet (y compris le patrimoine).
- Technique : l'export Actual est un zip qui contient `db.sqlite` et `metadata.json`. Le lire côté client avec sql.js (SQLite en WASM). Vérifier le schéma sur la version actuelle d'Actual (tables `accounts`, `categories`, `category_groups`, `transactions`, `payees`, `zero_budgets` ou `reflect_budgets`, `rules`). Les montants y sont stockés en centimes, sous forme d'entiers.

## Interactions et comportements
- Durées : 120 ms pour les survols et changements d'état, 180–220 ms pour l'ouverture des popovers et modales (opacité et translation de 4 px), avec un easing `cubic-bezier(0.2, 0, 0, 1)`. Rien de rebondissant. Respecter `prefers-reduced-motion`.
- Survol d'une ligne de tableau : fond `bg-hover`. Focus : anneau de 2 px en `accent` à 60 % d'opacité, décalé de 1 px.
- Les montants qui changent passent de l'ancienne à la nouvelle valeur par un fondu de 150 ms. Pas de compteur qui défile.
- Raccourcis : `⌘K` (palette), `N` (nouvelle opération), `←` / `→` (mois précédent / suivant sur Budget), `/` (recherche), `Échap` (fermer).
- Responsive : en dessous de 768 px, mise en page mobile (onglets en bas, tableaux transformés en listes). Entre 768 et 1100 px, la barre latérale se replie en icônes.
- États vides : une phrase et une action, sans illustration (ex. « Aucune opération ce mois-ci » + « Ajouter »).
- Chargement : lignes fantômes à la hauteur des vraies lignes, en `bg-hover`.

## État et données
- Fonctionnement local d'abord : stockage IndexedDB (ou SQLite en WASM), avec synchronisation optionnelle à prévoir plus tard. Montants stockés en centimes, sous forme d'entiers.
- Entités principales : Compte, Opération, Bénéficiaire, Groupe de catégories, Catégorie, Budget mensuel (catégorie × mois → montant budgété), Opération planifiée, Règle (bénéficiaire → catégorie), Actif, Estimation d'actif, Vue enregistrée (insights).
- Valeurs dérivées (à calculer, jamais à stocker) : disponible par catégorie (avec report du mois précédent comme dans Actual), à budgéter, reste à dépenser, solde projeté, moyennes glissantes, constats.

## Périmètre fonctionnel, à confirmer avec le porteur du projet
On reprend d'Actual le principe des enveloppes, le report du disponible d'un mois sur l'autre, les règles bénéficiaire → catégorie, les opérations planifiées et le rapprochement bancaire.
Le choix de ce qu'on simplifie ou retire (budget de suivi, opérations scindées, multidevise, synchronisation bancaire, etc.) n'a pas été tranché pendant la phase de design. **Il faut le valider avant de commencer le développement.**

## Fichiers
`designs/` contient :
- `Pistes graphiques.dc.html` : vue d'ensemble de toutes les explorations. Les pistes B, C et D ont été écartées et ne sont là que pour mémoire.
- `Piste A - Precision.dc.html` : direction retenue (budget desktop, opérations, saisie et rapports sur mobile).
- `A2 - Prevision.dc.html`, `A2 - Insights.dc.html`, `A2 - Patrimoine.dc.html`, `A2 - Import Export.dc.html` : modules complémentaires.
- `Logos Runway.dc.html` : propositions de logo (3e retenue).
- `budget-data.js` : jeu de données fictif utilisé par les maquettes (utile comme données de test).
- `support.js` : moteur d'affichage des maquettes (inutile pour le développement).

## Assets
Pas d'image ni d'icône dans les maquettes. Pour les icônes, utiliser Lucide en trait de 1,5 px, à 16 px sur desktop et 20 px sur mobile, en `text-muted`. Polices : Geist et Geist Mono (licence OFL).
