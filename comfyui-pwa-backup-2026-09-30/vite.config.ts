import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'ComfyUI Console',
        short_name: 'ComfyUI',
        description: 'Mobile-first ComfyUI remote console',
        theme_color: '#17181c',
        background_color: '#17181c',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        runtimeCaching: []
      }
    })
  ]
})
