# Pump Deck import

`src/launch/`, `shared/`, `server/`, `api/metadata.ts`, `api/rpc.ts`, and the original engine tests were copied byte-for-byte from [0xSneaks/pump-deck at 1d8cb586c1cfc030b6a98c923643c7bb0e810993](https://github.com/0xSneaks/pump-deck/tree/1d8cb586c1cfc030b6a98c923643c7bb0e810993). The Vite, TypeScript and Vercel setup uses that project's dependency manifest and config as its base.

The scaffold accepts a simulation and confirmation adapter from Step 3 and room feed entries from Step 4. It starts with neither connected. Review stays locked without a simulation, and the done view requires a confirmed result from the adapter.
