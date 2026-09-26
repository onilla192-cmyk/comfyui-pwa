import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
    manifest: { name: 'ComfyUI Console', short_name: 'ComfyUI', description: 'Personal ComfyUI workflow runner', theme_color: '#111318', background_color: '#111318', display: 'standalone', orientation: 'portrait', start_url: '/', scope: '/', icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ] },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,ico}'], runtimeCaching: [] },
  })],
  server: { host: true, port: 5173, proxy: {
    '/prompt': { target: 'http://127.0.0.1:8188', changeOrigin: true },
    '/history': { target: 'http://127.0.0.1:8188', changeOrigin: true },
    '/view': { target: 'http://127.0.0.1:8188', changeOrigin: true },
    '/upload': { target: 'http://127.0.0.1:8188', changeOrigin: true },
    '/interrupt': { target: 'http://127.0.0.1:8188', changeOrigin: true },
    '/ws': { target: 'ws://127.0.0.1:8188', ws: true, changeOrigin: true, secure: false },
  } },
})
