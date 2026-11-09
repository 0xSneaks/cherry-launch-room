import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The portal banner belongs to muse. My v2 draft stays in public/brand/ but must not ship.
const UNSHIPPED = ['brand/petaldeck-banner-v2.png'];
const dropUnshipped = (): Plugin => ({
  name: 'drop-unshipped',
  apply: 'build',
  closeBundle() {
    for (const f of UNSHIPPED) rmSync(resolve(__dirname, 'dist', f), { force: true });
  },
});

export default defineConfig({
  plugins: [nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util', 'events'], globals: { Buffer: true, process: true } }), dropUnshipped()],
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), debug: resolve(__dirname, 'debug/index.html') },
    },
  },
});
