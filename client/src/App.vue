<template>
  <div id="layout">
    <header>
      <RouterLink to="/" class="logo">TranscriptDisneyComics</RouterLink>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>
