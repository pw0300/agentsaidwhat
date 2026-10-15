import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __DEMO_MODE__: JSON.stringify(mode === 'demo') },
  base: mode === 'demo' ? './' : '/',
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
  server: { port: 5199 },
}))
