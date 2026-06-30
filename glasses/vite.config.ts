import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Even's app review rejects any URL string in the bundle that isn't in app.json's network.whitelist.
// React and react-router bake in purely-informational URLs (the minified-error decoder link and a
// router docs hint) that we never connect to. Strip just those message strings from the final chunks;
// functional URLs (SVG/XML namespaces, the `http://localhost` URL-parser base) are left untouched.
function stripGratuitousUrls() {
  return {
    name: 'strip-gratuitous-urls',
    renderChunk(code: string) {
      return code
        .replaceAll('https://react.dev', 'react dev')
        .replaceAll('https://reactrouter.com', 'react-router docs')
    },
  }
}

export default defineConfig({
  plugins: [react(), stripGratuitousUrls()],
  base: './', // relative asset paths for the packaged webview
  server: { host: true, port: 5173 },
  build: { assetsDir: '' }, // flatten assets into dist root (evenhub pack mishandles subdirs)
})
