import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
import './style.css'

import SearchView from './views/SearchView.vue'
import EntryView from './views/EntryView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: SearchView },
    { path: '/entry', component: EntryView },
  ],
})

createApp(App).use(router).mount('#app')