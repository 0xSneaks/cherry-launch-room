import { describe, expect, it, vi } from 'vitest';
import { cleanMetadata, metadataJson, pinMetadata } from './metadata';

const png = Buffer.from([137, 80, 78, 71]).toString('base64');
const good = { name: 'Cherry Blossom', symbol: 'PETAL', description: 'hi', website: 'https://petaldeck.fun', twitter: '', telegram: '', image: { type: 'image/png', data: png } };

describe('coin metadata', () => {
  it('accepts a normal form and drops empty links', () => {
    const m = cleanMetadata(good);
    expect(m.symbol).toBe('PETAL');
    expect(m.twitter).toBeUndefined();
    expect(metadataJson(m, 'bafyimg')).toEqual({ name: 'Cherry Blossom', symbol: 'PETAL', description: 'hi', image: 'https://ipfs.io/ipfs/bafyimg', showName: true, website: 'https://petaldeck.fun' });
  });
  it.each([
    [{ ...good, name: '' }, /Name/],
    [{ ...good, symbol: 'HAS SPACE' }, /Ticker/],
    [{ ...good, website: 'http://x.com' }, /https/],
    [{ ...good, image: { type: 'image/svg+xml', data: png } }, /PNG/],
    [{ ...good, image: { type: 'image/png', data: '' } }, /too large/],
  ])('rejects bad input %#', (body, msg) => {
    expect(() => cleanMetadata(body)).toThrow(msg);
  });
  it('pins the image, then the JSON pointing at it, and returns the metadata URI', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ IpfsHash: 'bafyimg' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ IpfsHash: 'bafymeta' })));
    const out = await pinMetadata(cleanMetadata(good), 'jwt', fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ uri: 'https://ipfs.io/ipfs/bafymeta', image: 'https://ipfs.io/ipfs/bafyimg' });
    const sent = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(sent.pinataContent.image).toBe('https://ipfs.io/ipfs/bafyimg');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer jwt');
  });
  it('fails closed when Pinata refuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    await expect(pinMetadata(cleanMetadata(good), 'jwt', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/pinata 401/);
  });
});
