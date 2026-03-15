/**
 * Robinhood Crypto API service.
 * Phase 6a — Real Portfolio: Crypto
 *
 * WAYPOINT [robinhood]
 * WHAT: Connects ARIA to Robinhood Crypto API for real account data — positions, cost basis, P&L.
 * WHY: Replaces generic market data with Nico's actual holdings so ARIA can give personal advice.
 * HOW IT HELPS NICO: ARIA says "you're up 14% on your BTC" not "BTC signal is WATCH."
 *
 * Uses tweetnacl for Ed25519 signing — Robinhood exports raw base64 keys that Node's OpenSSL
 * can fail to parse (ERR_OSSL_UNSUPPORTED), so we use pure JS Ed25519 instead.
 */

import nacl from "tweetnacl";
import { sign, createPrivateKey } from "crypto";

const ROBINHOOD_BASE = "https://trading.robinhood.com";

let requestCount = 0;
let lastResetAt = Date.now();
const RATE_LIMIT = 30;

function checkRateLimit(): void {
  const now = Date.now();
  if (now - lastResetAt >= 60_000) {
    requestCount = 0;
    lastResetAt = now;
  }
  if (requestCount >= RATE_LIMIT - 5) {
    console.warn(`Robinhood API: approaching rate limit (${requestCount}/${RATE_LIMIT})`);
  }
}

/**
 * Robinhood exports raw base64 (32-byte Ed25519 seed). Use tweetnacl to avoid OpenSSL decoder issues.
 */
function signWithRawBase64(raw: string, message: Buffer): string {
  const base64 = raw.replace(/\s/g, "").trim();
  const seed = new Uint8Array(Buffer.from(base64, "base64"));
  if (seed.length !== 32) {
    throw new Error(`Robinhood private key: expected 32 bytes, got ${seed.length}`);
  }
  const keypair = nacl.sign.keyPair.fromSeed(seed);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

/**
 * PEM format — try Node crypto (OpenSSL). Fails on some systems with Ed25519.
 */
function signWithPem(pem: string, message: Buffer): string {
  const key = createPrivateKey({ key: pem, format: "pem" });
  const sig = sign(null, message, key);
  return sig.toString("base64");
}

/**
 * Normalize PEM from .env (handles \n, \r\n, single-line). Returns null if not PEM.
 */
function normalizePem(raw: string): string | null {
  let pem = raw
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!pem.includes("-----BEGIN")) return null;
  const beginMatch = pem.match(/-----BEGIN [^-]+-----/);
  const endMatch = pem.match(/-----END [^-]+-----/);
  if (beginMatch && endMatch) {
    const begin = beginMatch[0];
    const end = endMatch[0];
    const middle = pem.slice(begin.length, pem.indexOf(end)).replace(/\s/g, "");
    if (middle && !pem.includes("\n")) {
      pem = `${begin}\n${middle}\n${end}`;
    }
  }
  return pem;
}

/**
 * Robinhood signs: api_key + timestamp + path + method + body (no separators).
 * See: https://stackoverflow.com/questions/78302239/how-to-post-using-robinhood-crypto-api-in-python
 */
function signRequest(
  apiKey: string,
  privateKeyRaw: string,
  timestamp: string,
  path: string,
  method: string,
  body: string
): string {
  const messageStr = `${apiKey}${timestamp}${path}${method}${body}`;
  const message = Buffer.from(messageStr, "utf8");

  const pem = normalizePem(privateKeyRaw);
  if (pem) {
    try {
      return signWithPem(pem, message);
    } catch {
      // OpenSSL may fail; fall through to try raw base64
    }
  }

  // Robinhood format: raw base64
  return signWithRawBase64(privateKeyRaw.trim(), message);
}

function getRobinhoodHeaders(path: string, method: string, body: string): Record<string, string> {
  const apiKey = process.env.ROBINHOOD_API_KEY?.trim() ?? "";
  const privateKeyPem = process.env.ROBINHOOD_PRIVATE_KEY?.trim() ?? "";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = signRequest(apiKey, privateKeyPem, timestamp, path, method, body);
  return {
    "x-api-key": apiKey,
    "x-timestamp": timestamp,
    "x-signature": sig,
    "Content-Type": "application/json",
    "User-Agent": "ARIA/1.0 (Robinhood Crypto API client)",
    "Accept": "application/json",
  };
}

function isConfigured(): boolean {
  return !!(process.env.ROBINHOOD_API_KEY?.trim() && process.env.ROBINHOOD_PRIVATE_KEY?.trim());
}

export type RobinhoodAccount = {
  buying_power: number;
  portfolio_value: number;
  currency: string;
};

export type RobinhoodHolding = {
  symbol: string;
  quantity: number;
  cost_basis: number;
  average_buy_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
};

export type RobinhoodSummary = {
  account: RobinhoodAccount;
  holdings: RobinhoodHolding[];
  last_updated: string;
};

const CRYPTO_SYMBOLS = ["BTC", "ETH"];
const ROBINHOOD_SYMBOL_MAP: Record<string, string> = { BTC: "BTC-USD", ETH: "ETH-USD" };

async function rhFetch<T>(path: string, options: RequestInit = {}): Promise<T | null> {
  if (!isConfigured()) return null;
  checkRateLimit();
  requestCount++;

  const url = `${ROBINHOOD_BASE}${path}`;
  const method = (options.method ?? "GET").toUpperCase();
  const body = options.body ?? "";
  const bodyStr = typeof body === "string" ? body : "";
  const headers = getRobinhoodHeaders(path, method, bodyStr);

  try {
    const res = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`Robinhood API ${path}: ${res.status}`, text.slice(0, 500));
      return null;
    }
    return text ? (JSON.parse(text) as T) : null;
  } catch (e) {
    console.warn("Robinhood API error:", e);
    return null;
  }
}

export async function fetchCryptoAccount(): Promise<RobinhoodAccount | null> {
  const path = "/api/v1/crypto/trading/accounts/";
  const data = await rhFetch<{ results?: Array<Record<string, unknown>> }>(path);
  if (!data?.results?.[0]) return null;
  const r = data.results[0] as Record<string, unknown>;
  const buyingPower = r.buying_power != null ? Number(r.buying_power) : 0;
  const portfolioValue = r.portfolio_value != null ? Number(r.portfolio_value) : 0;
  const currency = typeof r.currency === "string" ? r.currency : "USD";
  return { buying_power: buyingPower, portfolio_value: portfolioValue, currency };
}

export async function fetchCryptoHoldings(): Promise<RobinhoodHolding[] | null> {
  const path = "/api/v1/crypto/trading/holdings/";
  const data = await rhFetch<{ results?: Array<Record<string, unknown>> }>(path);
  if (!data?.results) return null;

  const holdings: RobinhoodHolding[] = [];
  for (const r of data.results) {
    const symbolRaw = (r.symbol ?? r.currency ?? (r as any).currency?.code ?? "") as string;
    const symbol = String(symbolRaw).replace(/-USD$/, "").toUpperCase();
    if (!CRYPTO_SYMBOLS.includes(symbol)) continue;

    const quantity = Number(r.quantity ?? r.amount ?? r.quantity_available ?? 0) || 0;
    const costBasis = Number(r.cost_basis ?? r.cost_basis_amount ?? r.cost_basis_price ?? 0) || 0;
    const avgBuy = Number(r.average_buy_price ?? r.average_price ?? r.average_buy ?? costBasis / (quantity || 1)) || 0;
    let currentPrice = Number(r.current_price ?? r.market_price ?? r.market_value ?? 0) || 0;
    if (currentPrice <= 0) currentPrice = (await fetchCryptoPrice(symbol)) ?? 0;
    const marketValue = Number(r.market_value ?? r.equity ?? r.value ?? quantity * currentPrice) || 0;
    const unrealizedPnl = Number(r.unrealized_pnl ?? r.unrealized_pnl_amount ?? marketValue - costBasis) || 0;
    const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

    holdings.push({
      symbol,
      quantity,
      cost_basis: costBasis,
      average_buy_price: avgBuy,
      current_price: currentPrice,
      market_value: marketValue,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: unrealizedPnlPct,
    });
  }
  return holdings;
}

export async function fetchCryptoPrice(symbol: string): Promise<number | null> {
  const rhSymbol = ROBINHOOD_SYMBOL_MAP[symbol.toUpperCase()] ?? `${symbol.toUpperCase()}-USD`;
  const path = `/api/v1/crypto/marketdata/best_bid_ask/?symbol=${encodeURIComponent(rhSymbol)}`;
  const data = await rhFetch<{
    best_bid?: string | number;
    best_ask?: string | number;
    results?: Array<{ best_bid?: string; best_ask?: string }>;
  }>(path);

  if (!data) return null;

  let bestBid: number;
  let bestAsk: number;

  if (data.results?.[0]) {
    const r = data.results[0];
    bestBid = parseFloat(String(r.best_bid ?? 0)) || 0;
    bestAsk = parseFloat(String(r.best_ask ?? 0)) || 0;
  } else {
    bestBid = parseFloat(String(data.best_bid ?? 0)) || 0;
    bestAsk = parseFloat(String(data.best_ask ?? 0)) || 0;
  }

  if (bestBid <= 0 && bestAsk <= 0) return null;
  if (bestBid <= 0) return bestAsk;
  if (bestAsk <= 0) return bestBid;
  return (bestBid + bestAsk) / 2;
}

export async function fetchCryptoPortfolioSummary(): Promise<RobinhoodSummary | null> {
  if (!isConfigured()) return null;

  const [account, holdings] = await Promise.all([fetchCryptoAccount(), fetchCryptoHoldings()]);
  if (!account && !holdings?.length) return null;

  return {
    account: account ?? { buying_power: 0, portfolio_value: 0, currency: "USD" },
    holdings: holdings ?? [],
    last_updated: new Date().toISOString(),
  };
}

export function logRobinhoodStatus(): void {
  if (!isConfigured()) {
    console.warn("  Robinhood: credentials not in .env — crypto prices use CoinGecko; Portfolio tab shows unconfigured state.");
  } else {
    console.log("  Robinhood: API key and private key present — crypto uses Robinhood primary, CoinGecko fallback.");
  }
}
