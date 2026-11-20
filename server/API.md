# 🦆 Transcript API — Documentation REST

Bienvenue dans la documentation officielle de l'**API Transcript**, le moteur standalone d'extraction OCR et de recherche plein texte dans les bulles de bandes dessinées Disney.

L'API fonctionne en **serveur indépendant (standalone)** sur le port `3001` et expose des routes REST standard avec réponses JSON, prise en charge de CORS, pagination, et recherche indexée SQLite FTS5.

---

## 📌 Sommaire
1. [Démarrage & Architecture](#démarrage--architecture)
2. [API publique (hébergée)](#api-publique-hébergée)
3. [Endpoints de Recherche Plein Texte](#1-recherche-plein-texte)
4. [Endpoints d'Édition & Correction des Transcriptions](#2-transcriptions--pages)
5. [Endpoints des Numéros & Publications](#3-numéros--publications)
6. [Endpoints Proxy de Scans](#4-proxy-de-scans)
7. [Endpoints Système & Statistiques](#5-système--statistiques)
8. [Codes d'Erreur HTTP](#codes-derreur-http)

---

## Démarrage & Architecture

L'API est hébergée dans `apps/transcript/server` :

```bash
# Démarrer le serveur API standalone
cd apps/transcript/server
node index.js
# L'API écoute sur http://localhost:3001
```

### Variables d'environnement configurables (`.env`) :
| Variable | Description | Valeur par défaut |
| :--- | :--- | :--- |
| `PORT` | Port d'écoute du serveur Express | `3001` |
| `TARGET_ARCHIVE_PATH` | Emplacement de la bibliothèque de scans (.cbz/.cbr) | `T:\Disney comics` |
| `TRANSCRIPT_DB_DIR` | Répertoire contenant `inducks.sqlite` et `search.sqlite` | `../../data/inducks-db` |
| `SCRATCH_DIR` | Dossier temporaire pour l'extraction rapide des planches | `C:\Users\starl\AppData\Local\Temp\transcript_scratch` |
| `OCR_CONFIDENCE_FLOOR` | Seuil de confiance minimum pour indexer les mots | `0.80` |

---

## API publique (hébergée)

Les routes `GET /api/search*` et `GET /api/health` sont aussi servies par un **Worker Cloudflare**
(`apps/transcript/worker`), qui lit une copie de l'index sur Turso. Elle répond même quand le PC est
éteint. La logique est la même, partagée dans `server/searchcore.js`.

- **Adresse** : `https://transcript-api.<sous-domaine>.workers.dev/api/...`, affichée par
  `node scripts/deploy.js`.
- **Clé obligatoire** : en-tête `X-API-Key`. Les clés se gèrent depuis le PC avec
  `node scripts/api-keys.js create|list|revoke`. Une clé peut être limitée à des origines (sites web).
- **Lecture seule** : `POST` répond `405`. Pas d'images (`imageUrl: null`), pas de résolution de
  storycode.
- **Erreurs propres** : `401` clé absente, inconnue ou révoquée ; `403` origine non autorisée pour
  cette clé ; `503` index pas encore envoyé.

```bash
curl -H "X-API-Key: tk_…" "https://transcript-api.<sous-domaine>.workers.dev/api/search?q=patinhas&entries=1"
```

---

## 1. Recherche Plein Texte

### `GET /api/search`
Effectue une recherche plein texte par mots-clés dans les bulles de dialogue de tous les scans transcrits.

#### Paramètres de requête (Query params) :
| Paramètre | Type | Requis | Description | Exemple |
| :--- | :--- | :--- | :--- | :--- |
| `q` | `string` | **Oui** | Mots ou phrase recherchée (insensible à la casse et aux accents) | `tondeuse`, `angle d'or` |
| `entries` | `boolean` | Non | Accepté pour compatibilité : `entries` (regroupement par entrée Inducks, calculé sur **toutes** les pages trouvées) est toujours renvoyé, avec `entryTotal` | `1` |
| `country` | `string` | Non | Filtre par pays de publication | `France`, `Italy` |
| `limit` | `integer` | Non | Nombre maximum de pages (`hits`, max `200`) et d'entrées (`entries`, max `1000`) renvoyées (défaut : `50`) | `20` |
| `offset` | `integer` | Non | Décalage pour la pagination (défaut: `0`) | `0` |

#### Exemple de requête :
```bash
curl -X GET "http://localhost:3001/api/search?q=topolino&entries=1&limit=10"
```

#### Exemple de réponse (`200 OK`) :
```json
{
  "query": "topolino",
  "match": "\"topolino\"*",
  "terms": ["topolino"],
  "total": 3,
  "limit": 10,
  "offset": 0,
  "entries": [
    {
      "key": "it/TL    1b",
      "entrycode": "it/TL    1b",
      "issuecode": "it/TL    1",
      "title": "Topolino e il cobra bianco",
      "hits": 2,
      "pages": [3, 5],
      "firstSnippet": "ecco topolino che arriva a tutta velocità...",
      "maxConfidence": 0.948
    }
  ]
}
```

---

### `GET /api/search/entry`
Récupère toutes les pages d'une **entrée**, d'un **numéro**, d'une **histoire** (storycode) ou d'un **titre**,
regroupées par **entrée** Inducks (`entries`) puis dans l'ordre du scan.

Une histoire (`storycode`) est publiée dans une entrée par numéro où elle paraît, souvent dans une autre
langue et sous un autre titre. `storycode=` renvoie toutes les entrées **possédées** de l'histoire, dans
l'ordre d'Inducks, chacune avec sa langue, son titre local et ses pages : les différentes transcriptions
d'une même histoire se comparent directement. Un numéro renvoie une entrée par histoire qu'il contient ;
un numéro qu'Inducks ne découpe pas, une seule entrée portant son `issuecode`.

#### Paramètres :
| Paramètre | Type | Requis | Description | Exemples acceptés |
| :--- | :--- | :--- | :--- | :--- |
| `code` | `string` | Optionnel* | Identifiant flexible (numéro, entrée, storycode) | `it/TL 1`, `it/TL 1b`, `TL 1`, `it/TL 0001`, `I TL 1-A` |
| `issue` | `string` | Optionnel* | Identifiant explicite du numéro | `it/TL 1`, `it/TL    1`, `TL 1` |
| `entry` | `string` | Optionnel* | Identifiant explicite de l'histoire | `it/TL 1b`, `it/TL    1b` |
| `storycode` | `string` | Optionnel* | Storycode officiel Inducks (Barks, Rosa, Martina...) | `I TL 1-A`, `W WDC 31-02` |
| `title` | `string` | Optionnel* | Recherche partielle par titre de l'histoire | `cobra bianco`, `l'or des incas` |
| `stories_only` | `boolean` | Non | Si `1` ou `true`, ne garde que les pages d'histoires : `kind` `n`, `k` ou `story`, ou page sans type rattachée à un titre (`searchdb.storyPageSql()`). Exclut couvertures, pubs, jeux, rédactionnel | `1` |
| `kind` | `string` | Non | Filtre exact sur `page.kind`. Deux vocabulaires coexistent : types Inducks (`n` histoire, `k` histoire-couverture, `c` couverture, `a` article, `g` jeu, `i` illustration…) et ceux de la segmentation (`story`, `editorial`) | `n` |
| `format` | `string` | Non | Format de restitution (`json`, `text`, `markdown`) | `text`, `markdown`, `json` |
| `min_confidence` | `float` | Non | Seuil de confiance minimum (ex: `0.85`) | `0.85` |

*\* Au moins l'un des paramètres d'identification (`code`, `issue`, `entry`, `storycode`, ou `title`) doit être renseigné.*

#### Formats de restitution disponibles (`format=...`) :
1. **JSON structuré (`format=json`, par défaut)** : Arborescence complète avec métadonnées, boxes, score et URLs d'images.
2. **Texte brut / Script (`format=text`)** : Transcription continue prête pour la lecture ou les LLM :
   ```text
   Topolino e il cobra bianco (it/TL    1b)
   Numéro Inducks : it/TL    1
   Pages : 9 (1 transcrites)
   ============================================================
   --- Page 2 (n) [confiance 95%] ---
   Qua-qua-qualche giochetto Paperino milionario al verde...
   ```
3. **Markdown (`format=markdown`)** : Fiche mise en forme avec citations `>` et aperçus des planches `![Planche](...)`.

#### Exemple de requête :
```bash
curl -X GET "http://localhost:3001/api/search/entry?code=it%2FTL++++1b"
curl -X GET "http://localhost:3001/api/search/entry?storycode=I+TL+553-AP"
```

#### Exemple de réponse (`storycode=I TL 553-AP`, abrégée) :
```json
{
  "type": "story",
  "storycode": "I TL 553-AP",
  "title": "Micky als Kurier des Zaren",
  "pageCount": 96,
  "transcribed": 96,
  "entries": [
    { "entrycode": "de/LTB  17h", "issuecode": "de/LTB  17", "languagecode": "de",
      "title": "Micky als Kurier des Zaren", "pageCount": 62, "transcribed": 62,
      "pages": [{ "id": 1234, "pageno": 190, "text": "…", "confidence": 0.93, "imageUrl": "/api/search/page/image?id=1234" }] },
    { "entrycode": "it/LGP  36f", "issuecode": "it/LGP  36", "languagecode": "it",
      "title": "Topolino corriere dello Zar", "pageCount": 33, "transcribed": 33, "pages": ["…"] }
  ]
}
```
En `format=text` et `format=markdown`, chaque entrée a son propre en-tête quand il y en a plusieurs.

---

## 2. Transcriptions & Pages

### `GET /api/search/page`
Récupère le texte OCR, le niveau de confiance, le nombre de bulles et le statut de relecture d'une page individuelle.

#### Paramètres :
| Paramètre | Type | Requis | Description | Exemple |
| :--- | :--- | :--- | :--- | :--- |
| `id` | `integer` | **Oui** | Identifiant unique de la page dans `search.sqlite` | `42` |

---

### `POST /api/search/page`
Enregistre une correction manuelle du texte de la page. Les corrections humaines priment sur l'OCR automatique et ne sont jamais écrasées.

#### Corps de la requête (`application/json`) :
```json
{
  "id": 42,
  "text": "Texte corrigé des bulles de dialogue de la planche."
}
```

---

### `GET /api/search/page/image`
Sert l'image de la planche originale extraite de l'archive (.cbz / .cbr) pour l'affichage côte-à-côte avec la transcription.

#### Paramètres :
| Paramètre | Type | Requis | Description |
| :--- | :--- | :--- | :--- |
| `id` | `integer` | **Oui** | ID de la page |

---

## 3. Numéros & Publications

### `GET /api/issues/entries`
Renvoie toutes les entrées et histoires associées à un numéro de parution, avec les URLs de scans Inducks et le statut de transcription.

#### Paramètres :
| Paramètre | Type | Requis | Description |
| :--- | :--- | :--- | :--- |
| `code` | `string` | **Oui** | Code du numéro (ex: `it/TL 1` ou `fr/PM 550`) |

---

## 4. Proxy de Scans

### `GET /api/scan`
Proxy d'images d'Inducks avec mise en cache locale sur disque. Permet de contourner les limitations CORS d'Inducks et d'afficher les scans haute résolution dans le lecteur.

#### Paramètres :
| Paramètre | Type | Requis | Description |
| :--- | :--- | :--- | :--- |
| `url` | `string` | **Oui** | URL publique Inducks / Outducks encodée |

---

## 5. Système & Statistiques

### `GET /api/health`
Vérification de santé complète du serveur API : uptime, mémoire, connexion TelDrive Blitz.cloud (avec keep-alive automatique toutes les 10 min), état des bases SQLite et statistiques de couverture OCR en temps réel.

#### Exemple de réponse :
```json
{
  "status": "ok",
  "timestamp": "2026-10-26T20:50:52.198Z",
  "uptime": "2h 15m 12s",
  "uptime_seconds": 8112,
  "system": {
    "node_version": "v22.21.0",
    "pid": 10424,
    "memory": { "rss_mb": 61.7, "heap_used_mb": 10.3, "heap_total_mb": 12.0 }
  },
  "services": {
    "teldrive": {
      "status": "mounted",
      "api_host": "http://teldrive:8080",
      "public_url": "https://drive.wizyx.blitz.cloud",
      "keep_alive": "active (ping every 3 min)",
      "mount_point": "T:\\Disney comics",
      "mount_ready": true,
      "available_countries": 24
    },
    "databases": {
      "search_sqlite": { "ready": true, "path": "...", "indexed_pages": 849 },
      "inducks_sqlite": { "ready": true, "path": "...", "size_mb": 1214.9 },
      "transcriptions_sqlite": { "ready": true, "entries_count": 0, "validated_count": 0 }
    },
    "cloud_ocr_pipeline": {
      "active": true,
      "workflow": "WizyxGH/Archiving-Helper/.github/workflows/ocr-pipeline.yml",
      "schedule": "Toutes les 6h + workflow_dispatch",
      "cloud_done_archives": 1,
      "last_cloud_run": "2026-10-26T20:21:47.000Z"
    }
  },
  "coverage": {
    "summary": {
      "total_pages": 849,
      "done_pages": 2,
      "pending_pages": 847,
      "failed_pages": 0,
      "completion_rate": "0.24%",
      "avg_confidence": 0.934,
      "total_issues": 8,
      "done_issues": 1
    },
    "by_publication": [
      {
        "publication": "it/TL",
        "country": "Italy",
        "total_pages": 464,
        "done_pages": 2,
        "pending_pages": 462,
        "issues": 3,
        "done_issues": 1,
        "avg_confidence": 0.934,
        "completion_rate": "0.4%"
      }
    ],
    "by_country": [
      { "country": "Italy", "total_pages": 849, "done_pages": 2, "issues": 8, "completion_rate": "0.2%" }
    ]
  }
}
```

---

### `GET /api/stats`
Rapport de progression globale de la bibliothèque de scans et de l'indexation OCR.

#### Exemple de réponse :
```json
{
  "status": "ok",
  "total_archives": 4068,
  "total_pages": 849,
  "pages_done": 2,
  "pages_pending": 847,
  "pages_indexed": 2,
  "percent_done": 0.24,
  "library_path": "T:\\Disney comics"
}
```

---

## Codes d'Erreur HTTP

| Code | Signification | Cause |
| :--- | :--- | :--- |
| `200 OK` | Succès | Requête traitée avec succès |
| `400 Bad Request` | Requête invalide | Paramètre obligatoire manquant ou syntaxe invalide |
| `404 Not Found` | Introuvable | L'entrée, la page ou le numéro demandé n'existe pas |
| `500 Server Error` | Erreur interne | Erreur d'accès base de données ou traitement |
| `502 Bad Gateway` | Échec proxy | Impossible de récupérer l'image distante Inducks |

