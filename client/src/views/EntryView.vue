<template>
  <div class="entry-view">
    <div class="bar">
      <input
        v-model="code"
        class="field"
        placeholder="Entrée, numéro ou storycode — ex. fr/JMC 5p012, I TL 553-AP"
        @keyup.enter="load"
      />
      <button class="btn btn-primary" :disabled="!code.trim() || loading" @click="load">
        <span v-if="loading" class="spinner"></span>
        <span v-else>Ouvrir</span>
      </button>
    </div>

    <p v-if="error" class="msg msg-error">{{ error }}</p>

    <template v-if="entry">
      <div class="head">
        <div>
          <div v-if="entry.storycode" class="issue">histoire {{ entry.storycode }} · {{ entry.entries.length }} entrée(s) possédée(s)</div>
          <div v-else class="issue">{{ entry.issuecode }}<span v-if="entry.segmented"> → {{ entry.entrycode }}</span></div>
          <h1>{{ entry.title || '— titre inconnu dans Inducks —' }}</h1>
        </div>
        <div class="stats">
          <strong>{{ entry.transcribed }}</strong> page(s) transcrite(s)
          <span v-if="entry.transcribed < entry.pageCount" class="muted">
            sur {{ entry.pageCount }} — l'OCR n'a pas fini
          </span>
        </div>
      </div>

      <p v-if="!entry.segmented" class="msg">
        Ce numéro n'est pas découpé en entrées par Inducks : les pages sont renvoyées
        dans l'ordre du scan, sans titre par histoire.
      </p>

      <!-- Grouped by Inducks entry: a story printed in several issues shows each printing
           under its own header (issue, language, local title). One row per page: the scan
           on the left, its text on the right. -->
      <section v-for="e in entry.entries" :key="e.entrycode" class="entry-group">
        <h2 v-if="entry.entries.length > 1" class="entry-head">
          <span class="issue">{{ e.issuecode }}<span v-if="e.entrycode !== e.issuecode"> → {{ e.entrycode }}</span></span>
          <span v-if="e.languagecode" class="badge">{{ e.languagecode }}</span>
          <span v-if="e.title">{{ e.title }}</span>
          <span class="muted">{{ e.transcribed }}/{{ e.pageCount }} page(s) transcrite(s)</span>
        </h2>
      <div v-for="p in e.pages" :key="p.id" class="page">
        <div class="page-head">
          <span class="pageno">page {{ p.pageno }}</span>
          <span class="muted">{{ p.n_boxes }} zone(s)</span>
          <span class="muted">confiance {{ Math.round((p.confidence || 0) * 100) }}%</span>
          <span v-if="p.reviewed" class="badge ok">corrigée</span>
          <span v-else-if="!p.text" class="badge warn">pas encore lue</span>
        </div>
        <div class="page-body">
          <img :src="p.imageUrl" class="scan" alt="scan de la page {{ p.pageno }}" loading="lazy" />
          <pre class="text" :title="p.text ? '' : 'OCR pas encore effectué'">{{ p.text || '— pas encore transcrite —' }}</pre>
        </div>
      </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import apiClient, { type EntryDetail } from '../api'

const code = ref('')
const entry = ref<EntryDetail | null>(null)
const loading = ref(false)
const error = ref('')

async function load() {
  const c = code.value.trim()
  if (!c) return
  loading.value = true
  error.value = ''
  try {
    entry.value = await apiClient.entry(c)
  } catch (e: any) {
    entry.value = null
    error.value = e.response?.data?.error || e.message
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  // Deep link: /entry?code=… opens straight onto a story.
  const q = new URLSearchParams(location.search).get('code')
  if (q) { code.value = q; await load() }
})
</script>

<style scoped>
.entry-view { max-width: 1100px; margin: 32px auto 60px; padding: 0 20px; }

.bar { display: flex; gap: 10px; }
.field {
  flex: 1; font-size: 15px; padding: 10px 14px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font-family: monospace;
}
.field:focus { outline: none; border-color: var(--accent); }

.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin: 22px 0 6px; flex-wrap: wrap; }
.issue { font-family: monospace; font-size: 12px; color: var(--accent); }
h1 { font-size: 20px; font-weight: 700; margin-top: 2px; }
.stats { font-size: 13px; color: var(--muted); }
.muted { color: var(--muted); font-size: 12px; }

.msg { margin-top: 14px; padding: 10px 14px; border-radius: var(--radius); background: var(--surface); font-size: 13px; }
.msg-error { background: rgba(247,79,109,0.1); border: 1px solid rgba(247,79,109,0.3); color: var(--red); }

.entry-group + .entry-group { margin-top: 24px; }
.entry-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 1.05rem;
  border-bottom: 1px solid var(--border, #334155); padding-bottom: 6px; }
.page { margin-top: 18px; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.page-head { display: flex; align-items: center; gap: 10px; padding: 7px 12px; background: var(--surface); border-bottom: 1px solid var(--border); }
.pageno { font-family: monospace; font-size: 12px; font-weight: 600; }
.badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); }
.badge.ok { color: var(--green); border-color: rgba(79,209,139,0.3); }
.badge.warn { color: var(--yellow); border-color: rgba(247,201,79,0.3); }

.page-body { display: grid; grid-template-columns: minmax(240px, 420px) 1fr; gap: 0; }
.scan { width: 100%; height: auto; display: block; background: #080a0e; border-right: 1px solid var(--border); }
.text {
  margin: 0; padding: 12px 14px; font-size: 13px; line-height: 1.65;
  white-space: pre-wrap; word-break: break-word; overflow-y: auto; max-height: 70vh;
  font-family: inherit; color: var(--text);
}
@media (max-width: 760px) {
  .page-body { grid-template-columns: 1fr; }
  .scan { border-right: none; border-bottom: 1px solid var(--border); }
}
</style>