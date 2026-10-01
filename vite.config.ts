import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5240 },
  build: { target: 'es2022' },
})
