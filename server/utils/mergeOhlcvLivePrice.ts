/**
 * Appends or updates the last OHLCV point from the live `prices` row (~5m refresh)
 * so holdings charts don't end at yesterday's daily close while the summary shows a fresher quote.
 * Underlying store remains daily bars from Alpha Vantage / CoinGecko; this only affects the GET response.
 */

export type OhlcvBar = { date: string; open: number; high: number; low: number; close: number; volume: number };

const MAX_QUOTE_AGE_MS = 72 * 60 * 60 * 1000; // allow weekend gaps without dropping Fri evening stale

export function mergeLivePriceIntoBars(bars: OhlcvBar[], live: { price: number; updated_at: string } | undefined): OhlcvBar[] {
  if (!bars.length || !live || live.price == null || !live.updated_at) return bars;
  const p = Number(live.price);
  if (!Number.isFinite(p) || p <= 0) return bars;
  const age = Date.now() - new Date(live.updated_at).getTime();
  if (!Number.isFinite(age) || age > MAX_QUOTE_AGE_MS) return bars;

  const quoteDay = String(live.updated_at).slice(0, 10);
  const last = bars[bars.length - 1];
  if (quoteDay < last.date) return bars;

  if (last.date === quoteDay) {
    const high = Math.max(last.high, p);
    const low = Math.min(last.low, p);
    return [...bars.slice(0, -1), { ...last, high, low, close: p }];
  }
  if (quoteDay > last.date) {
    const o = last.close;
    return [...bars, { date: quoteDay, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: 0 }];
  }
  return bars;
}
