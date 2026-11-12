// GET /api/config — public, non-secret app config for the PetalDeck form. Bundled to api/config.js by npm run build:api
// (unbundled @solana/web3.js crashed on Vercel: FUNCTION_INVOCATION_FAILED).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { feeRecipientFromEnv } from '../src/server/feeConfig.js';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    return res.status(200).json({ feeRecipient: feeRecipientFromEnv(process.env.PETALDECK_FEE_WALLET) });
  } catch {
    console.log('[config] PETALDECK_FEE_WALLET invalid');
    return res.status(500).json({ error: 'FEE_WALLET_INVALID' });
  }
}
