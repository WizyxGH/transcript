// src/api.ts — client de l'API de recherche
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

export interface SearchHit {
  id: number
  issuecode: string
  entrycode: string | null
  pageno: number
  confidence: number
  reviewed: boolean
  width: number | null
  height: number | null
  snippet: string
  title: string | null
}

export interface SearchEntry {
  key: string
  entrycode: string | null
  issuecode: string
  title: string | null
  hits: number
  pages: number[]
  firstSnippet: string
  maxConfidence: number
}

export interface SearchResponse {
  query: string
  match: string | null
  total: number
  limit: number
  offset: number
  hits: SearchHit[]
  entries: SearchEntry[]
}

export interface Progress {
  total: number
  done: number
  pending: number
  failed: number
  reviewed: number
  issues: number
  indexed: number
  percent: number
  confidence_floor: number
}

export interface PageDetail {
  id: number
  issuecode: string
  entrycode: string | null
  country: string | null
  languagecode: string | null
  pageno: number
  title: string | null
  text: string | null
  confidence: number
  n_boxes: number
  reviewed: boolean
  state: string
  width: number | null
  height: number | null
}

export interface EntryPage {
  id: number
  pageno: number
  text: string | null
  confidence: number
  reviewed: boolean
  n_boxes: number
  state: string
  width: number | null
  height: number | null
  imageUrl: string
}

/** One Inducks entry (a story as printed in one issue) with its pages. */
export interface EntryGroup {
  entrycode: string
  issuecode: string
  languagecode: string | null
  title: string | null
  pageCount: number
  transcribed: number
  pages: EntryPage[]
}

/**
 * Answer of /search/entry. An entry or an issue gives its entries; a storycode gives
 * every owned entry of that story (one per issue it is printed in), in Inducks order.
 */
export interface EntryDetail {
  type: string
  storycode: string | null
  entrycode: string
  issuecode: string
  title: string | null
  segmented: boolean
  pageCount: number
  transcribed: number
  entries: EntryGroup[]
}

export const apiClient = {
  search: (q: string, limit = 50) =>
    api.get<SearchResponse>('/search', { params: { q, limit } }).then(r => r.data),

  entry: (code: string) =>
    api.get<EntryDetail>('/search/entry', { params: { code } }).then(r => r.data),

  progress: () => api.get<Progress>('/search/progress').then(r => r.data),

  page: (id: number) =>
    api.get<PageDetail>('/search/page', { params: { id } }).then(r => r.data),

  pageImageUrl: (id: number) => `/api/search/page/image?id=${id}`,

  saveReview: (id: number, text: string) =>
    api.post<{ ok: boolean }>('/search/page', { id, text }).then(r => r.data),

  health: () => api.get<any>('/health').then(r => r.data),
}

export default apiClient