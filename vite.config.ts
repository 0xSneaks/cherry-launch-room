import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events'], globals: { Buffer: true, process: true } })],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), debug: resolve(__dirname, 'debug/index.html') },
    },
  },
});
