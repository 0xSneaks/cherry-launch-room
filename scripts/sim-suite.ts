// CLI: run the A–H suite on a local mainnet fork (reads only; nothing is signed or sent).
//   SOLANA_RPC_URL=<read rpc> npx vite-node scripts/sim-suite.ts [A,B,…] [pairMint]
// Prints the markdown table + JSON rows. Never prints the RPC URL.
import { PublicKey } from '@solana/web3.js';
import { rpcReader } from '../src/sim/fork.js';
import { runSuite, suiteMarkdown } from '../src/sim/suite.js';
import { ALL_VARIANTS, type AnyVariant } from '../src/spike/variants.js';

const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const want = (process.argv[2] ?? '')
  .split(',')
  .map((v) => v.trim().toUpperCase())
  .filter((v): v is AnyVariant => (ALL_VARIANTS as string[]).includes(v));
const pairMint = process.argv[3] ? new PublicKey(process.argv[3]) : undefined;

const rows = await runSuite({ rpcUrl, read: rpcReader(rpcUrl), variants: want.length ? want : undefined, pairMint });
console.log(`# A–H fork sim ${new Date().toISOString()}\n`);
console.log(suiteMarkdown(rows));
if (process.env.SIM_JSON) console.log(JSON.stringify(rows, null, 2));
