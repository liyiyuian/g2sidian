import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // relative asset paths for the packaged webview
  server: { host: true, port: 5173 },
  build: { assetsDir: '' }, // flatten assets into dist root (evenhub pack mishandles subdirs)
})
