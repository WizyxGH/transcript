# Transcript — recherche plein texte dans les scans

Fait l'OCR de chaque page de la bibliothèque de scans personnelle, puis permet de chercher un mot clé
et de savoir **dans quelles entrées Inducks** il apparaît (titre, numéro, pages), avec le scan et sa
transcription côte à côte.

```
bibliothèque (.cbr/.cbz)  ──index-library──▶  search.sqlite (pages en attente, cache SQLite 0 ms)
Inducks (inducks_entry)   ──segment-library─▶  page → entrycode + titre + kind ('story')
                           ──ocr_worker.py───▶  texte + index FTS5 (GPU CUDA, extraction 1-passe)
                                                   │
                         serveur Express :3001 ◀───┘──▶ client Vue :5173
                                 │ pousse les pages lues (toutes les 60 s)
                                 ▼
                         Turso (copie de l'index) ◀── Worker Cloudflare = API publique (clé d'API)
```

La recherche est aussi publique : un **Worker Cloudflare** sert les mêmes routes de lecture depuis une
copie de l'index sur **Turso**, PC éteint compris. Voir « API publique » plus bas.

## Prérequis

| Quoi | Où / comment |
|---|---|
| Node 22+, pnpm | `pnpm install` à la racine du monorepo (v22.21.0 activé via NVM / `C:\nvm4w\nodejs`) |
| Scans distants (TelDrive) | Disque `T:\Disney comics` monté par Archiving-Helper (`tools/mount-drive/mount_drive.py mount`), qui choisit l'adresse TelDrive (voir *Configuration*) |
| Base Inducks décompressée (1,2 Go) | `node server/scripts/unpack-inducks-db.js` |
| Python 3.12 + PaddleOCR (GPU CUDA) | `py -3.12 -m pip install paddlepaddle-gpu paddleocr`. Utiliser `py -3.12` : le `python` du PATH (3.14) n'a pas Paddle |
| UnRAR | WinRAR installé dans `C:\Program Files\WinRAR` (lecture des archives `.cbr`) |

## Mise en route

Depuis le dossier `apps/transcript/server` :

```bash
# 1. Recenser les archives et enregistrer leurs pages
# Les archives déjà recensées sont sautées ; une archive sans page lisible (chiffrée,
# corrompue) est signalée dans le bilan final au lieu d'être enregistrée vide.
node scripts/index-library.js                      # Recense tous les pays
node scripts/index-library.js --country France     # Filtrer sur un pays
node scripts/index-library.js --report             # Rapport d'avancement (pages, done, pending)

# 2. Rattacher chaque page à son entrée Inducks et identifier les histoires de BD
node scripts/segment-library.js                    # Segmente tous les numéros indexés
node scripts/segment-library.js --report           # Rapport de segmentation

# 3. Lancer l'OCR. Avec --continuous ou --all, le processus supervise un worker et le
# relance tout seul (voir « Mémoire » plus bas) : une seule commande suffit.
py -3.12 ocr_worker.py --continuous               # toutes les pages (défaut)
py -3.12 ocr_worker.py --continuous --stories-only # histoires seulement, passe partielle plus rapide

# Ou paralléliser sur 2 workers GPU indépendants (partitionnement CRC32 sans verrou) :
py -3.12 ocr_worker.py --worker-id 0 --num-workers 2 --continuous
py -3.12 ocr_worker.py --worker-id 1 --num-workers 2 --continuous

# Utilitaires ponctuels :
py -3.12 ocr_worker.py --list                      # État de la file d'attente
py -3.12 ocr_worker.py --reprocess-list            # Liste des numéros à repasser vers le pipeline v2 (structuré)
py -3.12 ocr_worker.py --reprocess --issue "it/TL 3704" # Repasser un numéro en version 2
py -3.12 ocr_worker.py --issue "fr/JMC   5"        # Traiter un seul numéro
py -3.12 ocr_worker.py --country France --all      # Traiter un pays entier

# 4. Interface web
node index.js                                      # API  http://localhost:3001
pnpm --filter @disney/transcript-client dev        # UI   http://localhost:5173

# Tests de non-régression
npm test
```

La recherche fonctionne **pendant** l'OCR : chaque page lue est indexée aussitôt dans FTS5. Si InducksButBetter tourne en même temps que le client Transcript, Vite bascule automatiquement sur le port 5174.

### Lancer (et relancer après un redémarrage du PC)

Une seule commande, côté PC : double-cliquer `apps/transcript/start.cmd` (ou `node scripts/start.js`
depuis `server/`). Elle :

1. vérifie que la bibliothèque est joignable ; sinon lance `mount_drive.py remount` d'Archiving-Helper
   (TelDrive s'endort quand plus rien ne le sollicite, le réveil prend 1 à 2 min) et l'attend ;
2. lance l'API (`node index.js`, port 3001), qui pousse aussi les nouvelles pages vers l'API publique ;
3. lance l'OCR (`py -3.12 -u ocr_worker.py --continuous`), qui reprend où il s'était arrêté ;
4. lance une fois l'indexation (`index-library.js` puis `segment-library.js`) : seules les archives
   ajoutées depuis la dernière fois sont lues, les autres sont sautées.

**API et OCR sont maintenus en vie** : s'ils s'arrêtent, `start.js` note la cause (code de sortie, durée)
et les relance après 30 s (délai doublé, jusqu'à 10 min, tant qu'ils retombent aussitôt).
**Chaque partie écrit son log horodaté** dans `server/logs/` (`ocr-AAAA-MM-JJ.log`, `api-…`, `index-…` ;
`TRANSCRIPT_LOG_DIR` pour un autre dossier). Sans ces fichiers, un OCR arrêté en cours de matinée
ne laissait aucune trace : la console disparaît avec sa fenêtre.

Ce qui tourne déjà n'est pas lancé deux fois ; Ctrl+C (ou fermer la fenêtre) arrête ce qu'elle a lancé.
Rien n'est perdu à l'arrêt : chaque page lue ou recensée est enregistrée au fur et à mesure.

Pour que TelDrive ne s'endorme pas quand l'API ne tourne pas, activer la tâche planifiée
`TelDriveKeepalive` (`mount_drive.py keepalive` ; `status` indique si elle est réellement active).

## API publique (hébergée)

L'API publique répond 24h/24, **même PC éteint**. Elle dessert les requêtes de recherche et de consultation pour [InducksButBetter](https://wizyxgh.github.io/InducksButBetter) et toute application cliente.

### URL et Accès
* **URL de base** : `https://transcript-api.wizyx.workers.dev`
* **Hébergement** : Worker Cloudflare (`apps/transcript/worker`)
* **Base de données** : Base hébergée Turso (`transcript-wizyx.aws-eu-west-1.turso.io`)
* **Authentification** : En-tête HTTP `X-API-Key: <votre_clé>` obligatoire pour toutes les requêtes (sauf `/api/health`).

### Endpoints disponibles

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Santé de l'API, statut Turso et quota (ne nécessite pas de clé) |
| `GET` | `/api/search?q={terme}&entries=1&limit={n}` | Recherche plein texte avec snippets, storycodes, entrées regroupées |
| `GET` | `/api/search/entry?code={entrycode}` | Planches et transcriptions associées à une entrée Inducks |
| `GET` | `/api/search/page?id={pageId}` | Détail et texte complet d'une planche |
| `GET` | `/api/search/progress` | Statistiques globales (pages done, indexées, issues) |
| `GET` | `/api/search/issues` | Liste des numéros avec état d'avancement OCR |

### Exemples d'appels

```bash
# 1. Vérification santé (sans clé)
curl https://transcript-api.wizyx.workers.dev/api/health

# 2. Recherche plein texte (avec clé API)
curl -H "X-API-Key: <CLE_API>" \
  "https://transcript-api.wizyx.workers.dev/api/search?q=Picsou&entries=1&limit=20"

# 3. Récupérer les pages d'une entrée spécifique
curl -H "X-API-Key: <CLE_API>" \
  "https://transcript-api.wizyx.workers.dev/api/search/entry?code=br/AD%20%20122e"
```

### Obtenir une clé d'API (Accès sur demande)

L'API est mise à disposition pour les projets communautaires et développeurs autour de Disney/Inducks. Afin de préserver les quotas de la base et la pérennité du service hébergé, **l'accès se fait sur demande**.

Pour obtenir une clé d'API :
1. Ouvrez une Issue sur le dépôt GitHub ou contactez l'administrateur (**Wizyx**).
2. Précisez :
   - Le nom de votre projet
   - Le cas d'usage (ex: application web, bot Discord, script d'analyse)
   - L'URL de votre site si applicable (pour sécuriser la clé via restriction d'origine CORS `Origin`)
3. Une clé formatée `tk_...` vous sera fournie de manière sécurisée.

### Sécurité & Quotas de l'API

* **Validation stricte** : toute clé invalide ou malformée est rejetée en amont (0 ms) sans interroger la base de données Turso.
* **Rate Limiting** : bridage automatique à **120 requêtes/minute par IP** (et blocage strict après 15 tentatives d'authentification invalides).
* **Mise en cache Edge** : les résultats de recherche sont mis en cache Cloudflare pendant 5 minutes (`s-maxage=300`) après authentification réussie.
* **Cloisonnement CORS** : les clés destinées aux sites web peuvent être restreintes à leur domaine pour empêcher la réutilisation par des tiers.

### Gestion des clés d'API (Administrateur)

Les clés sont générées et gérées depuis votre machine locale (`apps/transcript/server`) :

```bash
cd apps/transcript/server

# Créer une clé restreinte à un site Web (CORS sécurisé) :
node scripts/api-keys.js create InducksButBetter --origins https://wizyxgh.github.io

# Créer une clé libre (utilisable en script ou curl sans restriction d'origine) :
node scripts/api-keys.js create cli-perso

# Lister toutes les clés existantes :
node scripts/api-keys.js list

# Révoquer une clé compromise :
node scripts/api-keys.js revoke nom-de-la-cle
```

### Intégration dans InducksButBetter

Sur le projet `apps/InducksButBetter`, l'API publique est configurée via deux variables :
* `VITE_TRANSCRIPT_API="https://transcript-api.wizyx.workers.dev/api"`
* `VITE_TRANSCRIPT_API_KEY="<CLE_API>"`

Ces variables sont injectées en local dans `.env` et en production via les **Variables** et **Secrets** GitHub Actions du dépôt `WizyxGH/InducksButBetter`.

### Synchronisation automatique (PC → Cloud)
1. Lorsque votre PC local fait tourner l'OCR ou met à jour la base locale (`search.sqlite`), des triggers SQLite marquent les pages modifiées dans `hosted_dirty`.
2. Le serveur local (`node index.js`, lancé par `start.cmd`) pousse automatiquement les nouveaux lots vers Turso toutes les 60 secondes.
3. Pour forcer manuellement un envoi complet de rattrapage :
   ```bash
   node server/scripts/sync-hosted.js
   ```

## Utilisation

- **Recherche** (`/`) : insensible aux accents et à la casse, tous les mots doivent être présents, le
  dernier est complété en préfixe (`fetic` trouve `FÉTICHE`). Les mots composés sont découpés
  (`porte-bonheur` → `porte` ET `bonheur`). Résultats groupés par entrée avec les pages concernées.
- **Entrée** (`/entry?code=fr/JMC%20%20%205p012`) : scan à gauche, transcription à droite, page par
  page. Le texte est corrigeable ; une correction (`reviewed`) prime sur l'OCR et n'est jamais écrasée.
  Le champ accepte une entrée, un numéro ou un **storycode** (`/entry?code=I%20TL%20553-AP`) : une
  histoire affiche alors chacune de ses entrées possédées sous son propre en-tête (numéro, langue,
  titre local), pour comparer ses transcriptions d'une publication à l'autre.
- **Page d'accueil de l'API** (`http://localhost:3001`) : couverture OCR par publication — gris
  pas commencé, ambre en cours, vert à partir de 90 % (`COVERAGE_GREEN_FROM` dans `index.js`).

## Configuration

Rien n'est écrit en dur côté machine. Chaque clé se résout dans l'ordre : variable d'environnement →
`.env` d'Archiving-Helper (`Projets/Automatisations/Archiving-Helper/tools/download-files/.env`, lu par
`server/config.js` et `ocr_worker.py`) → valeur par défaut.

| Clé | Défaut | Rôle |
|---|---|---|
| `TARGET_ARCHIVE_PATH` | `T:\Disney comics` | Bibliothèque de scans montés (partagée avec Archiving-Helper) |
| `TRANSCRIPT_DB_DIR` | `DisneyComicsHub\data\inducks-db` | `inducks.sqlite` + `search.sqlite` |
| `SEARCH_DB` | `<TRANSCRIPT_DB_DIR>\search.sqlite` | Base de recherche FTS5 |
| `SCRATCH_DIR` | `%TEMP%\transcript_scratch` | Dossier temporaire pour l'extraction 1-passe |
| `INDUCKS_SQLITE` | `<TRANSCRIPT_DB_DIR>\inducks.sqlite` | Base Inducks décompressée |
| `TELDRIVE_API_HOST` | *(aucun ici)* | Adresse locale de TelDrive (nom Tailscale `http://teldrive:8080`). Défauts et choix de l'adresse : Archiving-Helper (`src/core/config.py`, `teldrive_client.resolve_host`) |
| `TELDRIVE_PUBLIC_URL` | *(aucun ici)* | Adresse publique ; l'API la pingue toutes les 3 min pour que l'hébergement ne s'endorme pas |
| `OCR_CONFIDENCE_FLOOR` | `0.80` | Confiance moyenne minimale pour indexer une page (`--floor`) |
| `OCR_READ_ROW_FRACTION` | `0.10` | Hauteur d'une « rangée » de bulles pour l'ordre de lecture |
| `OCR_MEMORY_LIMIT_MB` | `6000` | Mémoire maximale du worker (plafond Windows). Compte aussi la mémoire que CUDA réserve pour le GPU (~3 Go) : à 3 800, toute page très chargée en texte (50+ lignes) échouait en « mémoire GPU épuisée » |
| `OCR_STALL_S` | `1800` | Silence du worker (secondes) au-delà duquel le superviseur le tue et le relance |
| `OCR_MIN_FREE_COMMIT_MB` | `2000` | Mémoire libre laissée aux autres programmes : en dessous, l'OCR se met en pause |
| `PORT` | `3001` | Port d'écoute de l'API |
| `TRANSCRIPT_PYTHON` | `py -3.12` | Python utilisé par `start.js` (OCR, remontage de T:) |
| `TRANSCRIPT_LOG_DIR` | `server/logs` | Logs horodatés de `start.js` (un fichier par partie et par jour) |
| `TRANSCRIPT_TURSO_URL` | *(aucun)* | Base Turso de l'API publique ; vide = pas d'envoi. Écrit par `hosted-setup.js` |
| `TRANSCRIPT_TURSO_TOKEN` | *(aucun)* | Jeton accès complet (le PC écrit) |
| `TRANSCRIPT_TURSO_READ_TOKEN` | *(aucun)* | Jeton lecture seule, donné au Worker par `worker/scripts/deploy.js` |
| `TRANSCRIPT_SYNC_MS` | `60000` | Intervalle d'envoi des nouvelles pages par l'API locale |
| `TURSO_PLATFORM_TOKEN`, `TURSO_ORG` | *(aucun)* | Seulement pour `hosted-setup.js` (création de la base) |
| `TRANSCRIPT_TURSO_DB`, `TURSO_GROUP` | `transcript`, 1er groupe | Nom et groupe de la base créée |

## Mémoire et robustesse

L'OCR tourne des jours sur une machine partagée (archivage Archiving-Helper, navigateur…). Les règles :

- **Plafond par worker** (`OCR_MEMORY_LIMIT_MB`) : un pic de Paddle (~2,5 Go sur certaines pages)
  devient une `MemoryError` dans le worker seul au lieu de saturer la mémoire de toute la machine.
- **Mémoire GPU plafonnée** (`FLAGS_gpu_memory_limit_mb`) : sans plafond, le pilote Windows déborde en
  RAM système quand les 4 Go de la carte sont pleins.
- **Pause polie** (`OCR_MIN_FREE_COMMIT_MB`) : avant chaque page, le worker attend que la machine ait
  assez de mémoire libre ; avant de lancer ou relancer un worker, le superviseur attend la place d'un
  worker entier en plus (`OCR_MEMORY_LIMIT_MB`), sinon le nouveau worker mourrait au chargement.
- **Superviseur** : sur épuisement mémoire, le worker sort (code 75) et est relancé ; un plantage
  natif après une vraie période de travail aussi ; une erreur dans la première minute (installation,
  base absente) arrête tout au lieu de boucler.
- **Page trop lourde** : abandonnée (état `failed`) après 2 épuisements mémoire de suite, seulement si
  la machine avait de la mémoire libre à ce moment-là ; sinon la page reste en attente.
- **Stockage injoignable** (TelDrive hors ligne) : la page reste en attente et le worker réessaie
  toutes les minutes, au lieu de marquer toute la file en échec.
- **Lecture bloquée sur `T:`** : une lecture sur le montage rclone peut rester bloquée plusieurs dizaines
  de minutes ; le worker restait alors vivant mais figé (0 % GPU, impossible à tuer) et l'OCR
  « s'arrêtait » sans rien dans les logs. Le worker signale qu'il est vivant à chaque page et à chaque
  attente ; muet `OCR_STALL_S` (30 min), le superviseur le tue, remonte `T:` s'il ne meurt pas (seul
  moyen de libérer la lecture), puis relance un worker (code de sortie 76).
- **Grosses archives sur TelDrive** : l'extraction lit toute l'archive par le montage ; le délai accordé
  suit sa taille (60 s + 1 s par Mo, `extract_timeout_s`). Un dépassement laisse la page en attente :
  c'est le stockage qui est lent, pas l'archive qui est mauvaise.
- **Pages très chargées en texte** : la reconnaissance lit les lignes par paquets de 8 (`--rec-batch-num`).
  À 16, une page de 51 lignes débordait des 4 Go du GPU ; à 8 elle passe, même texte, même confiance.
- **Extraction impossible faute de mémoire** (`UnRAR` qui ne peut pas démarrer, code `0xC0000142`,
  ou fichier d'échange plein) : ce n'est pas l'archive qui est en cause, la page reste en attente.

Chacune de ces règles a son test dans `server/test/regressions.test.js`.

## Architecture & Optimisations

- **Extraction en une passe (`IssueExtractor`)** : Au lieu d'extraire les images page par page depuis le disque distant (ce qui prenait 1 à 2 secondes par page d'I/O réseau), le worker extrait l'archive complète en une seule fois dans le cache SSD local (`SCRATCH_DIR/worker_<id>`). L'accès aux images suivantes passe à **< 1 ms**.
- **Accélération GPU CUDA** : Exécution sur GPU NVIDIA avec PaddleOCR (`PP-OCRv5_mobile_det` + `latin_PP-OCRv5_mobile_rec`). Mesuré : 0,1 – 0,4 s par page, soit environ **4 000 pages/h** par worker, redémarrages compris.
- **Partitionnement parallèle sans verrou** : Les options `--worker-id` et `--num-workers` distribuent les numéros de manière déterministe via hachage CRC32 (`crc32(issuecode) % num_workers == worker_id`). Plusieurs workers peuvent tourner simultanément sans aucun conflit de verrouillage SQLite.
- **Commits groupés (Batch commits)** : Les écritures en base se font par lots de 10 pages ou à la fin de chaque numéro pour éliminer la contention SQLite.
- **Toutes les pages par défaut** : la recherche doit trouver un mot où qu'il soit imprimé (couvertures, rédactionnel, jeux, numéros qu'Inducks ne segmente pas). `--stories-only` limite l'OCR aux pages d'histoires (`kind` `n`, `k` ou `story`, défini une seule fois : `searchdb.storyPageSql()`, recopié dans `ocr_worker.story_page_sql()` et vérifié identique par un test).
- **Cache d'indexation instantané** : `index-library.js` charge en mémoire la liste des archives déjà recensées, évitant de ré-analyser inutilement les répertoires distants.
- **Lecture minimale sur TelDrive** : sur `T:`, chaque octet lu est un téléchargement. Une CBZ est listée depuis son répertoire central, à la fin du fichier (quelques Ko), au lieu d'être lue entière (23 s par CBZ de 88 Mo, ~9 h pour 1 480 archives). Un fichier chiffré par TelDrive est reconnu à son en-tête `TELDRIVE` (8 octets) et écarté en ~2 s, sans lancer UnRAR (15 s puis timeout).
- **Ratés de TelDrive** : une erreur d'entrée/sortie passagère (`EIO`, `ETIMEDOUT`…) sur `T:` est réessayée 2 fois à 30 s d'intervalle avant de déclarer l'archive illisible. Une archive restée illisible n'est pas enregistrée : la prochaine exécution la reprend.
- **Protection anti-blocage UnRAR** : Gestion des archives corrompues avec timeout et drapeaux non-bloquants (`-y`) pour empêcher tout blocage sur `stdin`.

## API

| Route | Rôle |
|---|---|
| `GET /api/search?q=…&limit=&offset=&country=&issue=&entry=` | Pages trouvées (`hits`, 200 max) + entrées (`entries`, sur **toutes** les pages trouvées, `limit` max 1 000) |
| `GET /api/search/entry?code=<entrycode\|issuecode>` · `?storycode=` | Pages regroupées par entrée Inducks (`entries`). Avec `storycode`, toutes les entrées possédées d'une même histoire (une par numéro, avec langue et titre local) pour comparer ses transcriptions |
| `GET /api/search/page?id=` · `POST /api/search/page {id,text}` | Lire / corriger une page |
| `GET /api/search/page/image?id=` | Le scan de la planche originale |
| `GET /api/search/progress` · `GET /api/search/issues` | État d'avancement et numéros indexés |
| `GET /api/health` | Diagnostic santé de l'API et des bases de données |

Les routes `GET /api/search*` existent aussi sur l'API publique, avec une clé (voir plus haut).
Pour la documentation REST complète, consultez [`server/API.md`](server/API.md).

## Limites connues

- **Mickey Magazine (Nederlandstalig)** : 439 archives sur 468 sont stockées chiffrées dans TelDrive
  sans leur sel de déchiffrement (perdu à l'envoi d'origine) : illisibles, l'indexeur les signale.
  Les copies de `D:\Duckburg Archives` sont chiffrées elles aussi (même en-tête `TELDRIVE`, mêmes
  tailles : copiées depuis `T:`), et les messages Telegram d'origine ont été supprimés le 11/10.
  À renvoyer depuis une source saine (liste : Archiving-Helper,
  `tools/download-files/files_downloads/teldrive_encrypted_to_reupload.json`), en CBZ
  (`tools/convert-cbr-to-cbz`).
- Les numéros dont Inducks ne donne pas les positions (intégrales…) ne sont pas segmentés : leurs pages
  sont cherchables mais sans titre d'entrée.
