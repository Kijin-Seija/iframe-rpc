import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: '.',
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'shared/**',
        'packages/**/src/**'
      ],
      exclude: [
        'demo/**',
        'packages/iframe-rpc-client/dist/**',
        'packages/iframe-rpc-server/dist/**'
      ]
    }
  }
})
