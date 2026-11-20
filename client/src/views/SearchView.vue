<template>
  <div class="search-view">
    <form class="bar" @submit.prevent="run">
      <input
        v-model="query"
        class="field"
        placeholder="Rechercher un mot dans les scans — ex. magicien, porte-bonheur, Zoiville"
        autofocus
      />
      <button class="btn btn-primary" type="submit" :disabled="!query.trim() || loading">
        <span v-if="loading" class="spinner"></span>
        <span v-else>Rechercher</span>
      </button>
    </form>

    <p v-if="error" class="msg msg-error">{{ error }}</p>

    <div v-if="result" class="result-head">
      <strong>{{ result.total }}</strong>
      <span v-if="result.total > 1"> page(s) trouvée(s)</span>
      <span v-else> page trouvée</span>
      <span class="muted"> dans {{ result.entries.length }} entrée(s)</span>
      <span class="muted"> · réponse en {{ elapsed }} ms</span>
    </div>

    <p v-if="searched && result && result.total === 0" class="msg">
      Rien. L'OCR n'a peut-être pas encore passé sur ce numéro —
      {{ progress.done }} page(s) sur {{ progress.total }} sont lues.
    </p>

    <!-- Results, grouped by entry: the question is "found in which entries" -->
    <ul v-if="entries.length" class="entries">
      <li v-for="e in entries" :key="e.key" class="entry">
        <div class="entry-head">
          <span class="issue">{{ e.issuecode }}</span>
          <!-- Clicking the title opens every page of that story, not just the hits. -->
          <RouterLink class="title link" :to="{ path: '/entry', query: { code: e.key } }">
            {{ e.title || '— titre inconnu dans Inducks —' }}
          </RouterLink>
          <span class="badge" :title="`${e.hits} page(s) concernée(s)`">
            {{ e.hits }} p{{ e.hits > 1 ? 'ages' : 'age' }}
          </span>
          <span v-if="e.maxConfidence < 1" class="badge warn"
                title="Confiance OCR imparfaite sur cette entrée">OCR {{ Math.round(e.maxConfidence * 100) }}%</span>
        </div>
        <div class="snippet">{{ e.firstSnippet }}</div>
        <div class="pages">
          <span class="muted">pages :</span>
          <button v-for="p in e.pages.slice(0, 40)" :key="p" class="page" @click="open(p, e)">
            {{ p }}
          </button>
          <span v-if="e.pages.length > 40" class="muted">… +{{ e.pages.length - 40 }}</span>
        </div>
      </li>
    </ul>

    <!-- OCR progress: the index only covers what has been read so far -->
    <div class="progress">
      <div class="bar-track"><div class="bar-fill" :style="{ width: pct + '%' }"></div></div>
      <span class="muted">
        {{ progress.indexed }} page(s) indexées sur {{ progress.total }}
        <template v-if="progress.pending"> · {{ progress.pending }} restantes</template>
      </span>
    </div>

    <!-- Page review: the scan next to its transcription -->
    <div v-if="current" class="modal" @click.self="current = null">
      <div class="modal-box">
        <div class="modal-head">
          <span>{{ current.issuecode }} — page {{ current.pageno }}</span>
          <button class="btn btn-sm" @click="current = null">✕</button>
        </div>
        <div class="modal-body">
          <img :src="imageUrl" class="scan" alt="scan" />
          <div class="side">
            <label>{{ current.title || 'Sans titre' }}</label>
            <textarea v-model="draft" rows="16"></textarea>
            <div class="modal-actions">
              <button class="btn btn-success" :disabled="!dirty || saving" @click="save">
                <span v-if="saving" class="spinner"></span>
                Enregistrer la correction
              </button>
              <span class="muted">
                confiance {{ Math.round((current.confidence || 0) * 100) }}% ·
                {{ current.n_boxes }} zone(s)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import apiClient, { type SearchResponse, type SearchEntry, type PageDetail } from '../api'

const query = ref('')
const result = ref<SearchResponse | null>(null)
const loading = ref(false)
const searched = ref(false)
const error = ref('')
const elapsed = ref(0)
const progress = ref({ total: 0, done: 0, pending: 0, indexed: 0 })

const current = ref<PageDetail | null>(null)
const draft = ref('')
const saving = ref(false)
const imageUrl = ref('')
const dirty = computed(() => current.value !== null && draft.value !== (current.value.text || ''))

const entries = computed<SearchEntry[]>(() => result.value?.entries ?? [])
const pct = computed(() =>
  progress.value.total ? Math.round((100 * progress.value.done) / progress.value.total) : 0
)

async function run() {
  const q = query.value.trim()
  if (!q) return
  loading.value = true
  error.value = ''
  searched.value = true
  const t0 = performance.now()
  try {
    result.value = await apiClient.search(q)
    elapsed.value = Math.round(performance.now() - t0)
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message
  } finally {
    loading.value = false
  }
}

/** Open the scan page for one hit; the id is looked up from the current results. */
async function open(pageno: number, entry: SearchEntry) {
  const hit = result.value?.hits.find(
    h => h.pageno === pageno && (h.entrycode || h.issuecode) === entry.key
  ) ?? result.value?.hits.find(h => h.pageno === pageno)
  if (!hit) return
  try {
    const page = await apiClient.page(hit.id)
    current.value = page
    draft.value = page.text || ''
    imageUrl.value = apiClient.pageImageUrl(hit.id)
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message
  }
}

async function save() {
  if (!current.value) return
  saving.value = true
  try {
    await apiClient.saveReview(current.value.id, draft.value)
    // Reflect the correction in the results already on screen.
    if (result.value) {
      const h = result.value.hits.find(x => x.id === current.value!.id)
      if (h) { h.reviewed = true; h.snippet = draft.value.slice(0, 160).replace(/\n/g, ' ') }
    }
    current.value = null
  } catch (e: any) {
    error.value = e.response?.data?.error || e.message
  } finally {
    saving.value = false
  }
}

async function loadProgress() {
  try { progress.value = await apiClient.progress() } catch { /* the bar is optional */ }
}

onMounted(loadProgress)
</script>

<style scoped>
.search-view { max-width: 860px; margin: 32px auto 60px; padding: 0 20px; }

.bar { display: flex; gap: 10px; }
.field {
  flex: 1; font-size: 15px; padding: 10px 14px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text);
}
.field:focus { outline: none; border-color: var(--accent); }

.result-head { margin: 18px 0 10px; font-size: 14px; }
.muted { color: var(--muted); font-size: 12px; }

.msg { margin-top: 16px; padding: 10px 14px; border-radius: var(--radius); background: var(--surface); font-size: 13px; }
.msg-error { background: rgba(247,79,109,0.1); border: 1px solid rgba(247,79,109,0.3); color: var(--red); }

.entries { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.entry {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px;
}
.entry-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.issue { font-family: monospace; font-size: 12px; color: var(--accent); font-weight: 600; }
.title { font-size: 14px; font-weight: 600; }
.badge {
  font-size: 11px; color: var(--muted); background: var(--card);
  border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px;
}
.badge.warn { color: var(--yellow); border-color: rgba(247,201,79,0.3); }

.snippet {
  margin: 6px 0 8px; font-size: 13px; color: var(--text);
  white-space: pre-wrap; max-height: 3.2em; overflow: hidden;
}

.pages { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.page {
  font-family: monospace; font-size: 11px; padding: 2px 7px; cursor: pointer;
  background: var(--card); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px;
}
.page:hover { border-color: var(--accent); color: var(--accent); }

.progress { margin-top: 26px; display: flex; align-items: center; gap: 10px; }
.bar-track { flex: 1; height: 4px; background: var(--card); border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); transition: width 0.3s ease; }

/* Review modal */
.modal {
  position: fixed; inset: 0; background: rgba(0,0,0,0.72);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.modal-box {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); max-width: 1200px; width: 100%;
  max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;
}
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 13px;
}
.modal-body { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px; overflow: auto; }
.scan { max-width: 100%; max-height: 70vh; object-fit: contain; background: #080a0e; border-radius: 4px; }
.side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.side label { font-size: 13px; font-weight: 600; }
.side textarea {
  font-family: inherit; font-size: 13px; resize: vertical;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius); padding: 8px;
}
.modal-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>