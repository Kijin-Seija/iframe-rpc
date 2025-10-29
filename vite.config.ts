import { defineConfig } from 'vite'

// 库模式构建配置：仅打包 src/index.ts 为库输出
export default defineConfig({
  root: 'demo',
  publicDir: '../public',
  test: {
    environment: 'node',
  },
  build: {
    lib: {
      entry: 'index.ts',
      name: 'IframeRpc',
      fileName: 'iframe-rpc',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      // 如有外部依赖可在此标记为 external
      external: [],
    },
    // 开启压缩，产物更小
    minify: true,
    sourcemap: false,
  },
})
