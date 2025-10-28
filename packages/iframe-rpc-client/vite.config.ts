import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'IframeRpcClient',
      fileName: 'index',
      formats: ['es', 'umd'],
    },
    minify: true,
    sourcemap: false,
  },
})

