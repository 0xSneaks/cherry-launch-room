import { describe, expect, it } from 'vitest';
import { filterPairs, fmtUsd, type PairInfo } from './pairs';

const p = (name: string, symbol: string, category: PairInfo['category']): PairInfo => ({ mint: `${symbol}mint`, name, symbol, icon: null, category, mcap: null, liquidity: null });
const list = [p('Bitcoin', 'BTC', 'crypto'), p('Tesla', 'TSLA', 'stocks'), p('@gork', 'gork', 'memes')];

describe('custom pair picker', () => {
  it('filters by chip and searches name / ticker / mint, keeping Pump order', () => {
    expect(filterPairs(list, 'all', '').map((x) => x.symbol)).toEqual(['BTC', 'TSLA', 'gork']);
    expect(filterPairs(list, 'stocks', '').map((x) => x.symbol)).toEqual(['TSLA']);
    expect(filterPairs(list, 'all', '$tsl').map((x) => x.symbol)).toEqual(['TSLA']);
    expect(filterPairs(list, 'crypto', 'gork')).toEqual([]);
    expect(filterPairs(list, 'all', 'GORKMINT').map((x) => x.symbol)).toEqual(['gork']);
  });
  it('formats money like Pump', () => {
    expect(fmtUsd(170_380_000)).toBe('$170.38M');
    expect(fmtUsd(33_340)).toBe('$33.34K');
    expect(fmtUsd(912)).toBe('$912');
    expect(fmtUsd(null)).toBe('');
  });
});
