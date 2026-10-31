import { iwsdkDev } from '@iwsdk/vite-plugin-dev'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [iwsdkDev()],
  server: { host: '0.0.0.0', port: 4473, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
})
