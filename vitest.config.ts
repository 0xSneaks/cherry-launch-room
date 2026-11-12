import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'api/**/*.test.ts', 'server/**/*.test.ts'],
    server: { deps: { inline: ['@pump-fun/pump-sdk', '@pump-fun/agent-payments-sdk'] } },
  },
});
