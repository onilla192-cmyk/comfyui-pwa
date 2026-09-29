import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
        manifest: {
          name: 'ComfyUI Console',
          short_name: 'ComfyUI',
          description: 'Personal ComfyUI workflow runner',
          theme_color: '#111318',
          background_color: '#111318',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '/',
          scope: '/',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
          runtimeCaching: [],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      host: true,
      port: 3000,
      proxy: {
        '/prompt': { target: 'http://127.0.0.1:8188', changeOrigin: true },
        '/history': { target: 'http://127.0.0.1:8188', changeOrigin: true },
        '/view': { target: 'http://127.0.0.1:8188', changeOrigin: true },
        '/upload': { target: 'http://127.0.0.1:8188', changeOrigin: true },
        '/interrupt': { target: 'http://127.0.0.1:8188', changeOrigin: true },
        '/launcher': { target: 'http://127.0.0.1:8190', changeOrigin: true },
        '/ws': { target: 'ws://127.0.0.1:8188', ws: true, changeOrigin: true, secure: false },
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
