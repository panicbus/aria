/**
 * Technical indicators: RSI (14), MACD (12,26,9), SMA 20/50.
 * Pure JS, no deps. Used by signal generation and backtest engine.
 */

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) out.push(NaN);
    else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[j];
      out.push(sum / period);
    } else out.push((values[i] - out[i - 1]) * k + out[i - 1]);
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) out.push(NaN);
    else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += values[j];
      out.push(sum / period);
    }
  }
  return out;
}

export function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;
  let avgGain = 0,
    avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) avgGain += ch;
    else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): { macd: number; signal: number; histogram: number } | null {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) macdLine.push(NaN);
    else macdLine.push(emaFast[i] - emaSlow[i]);
  }
  const validMacd = macdLine.filter((v) => !isNaN(v));
  if (validMacd.length < signalPeriod) return null;
  const signalEma = ema(validMacd, signalPeriod);
  const sigVal = signalEma[signalEma.length - 1];
  const macVal = validMacd[validMacd.length - 1];
  return { macd: macVal, signal: sigVal, histogram: macVal - sigVal };
}

export function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return NaN;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

export type IndicatorData = {
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  ma20: number;
  ma50: number;
  score: number;
  methodology: "technical_composite";
};

export function computeIndicatorsForCloses(closes: number[]): IndicatorData | null {
  if (closes.length < 50) return null;
  const rsi = calcRSI(closes);
  const macd = calcMACD(closes);
  const ma20 = calcSMA(closes, 20);
  const ma50 = calcSMA(closes, 50);
  if (isNaN(rsi) || !macd || isNaN(ma20) || isNaN(ma50)) return null;

  let score = 0;
  if (rsi < 30) score += 2;
  else if (rsi < 45) score += 1;
  else if (rsi <= 55) score += 0;
  else if (rsi <= 70) score -= 1;
  else score -= 2;

  const prevMacd = closes.length >= 2 ? calcMACD(closes.slice(0, -1)) : null;
  const macdCrossUp = prevMacd && macd.histogram > 0 && prevMacd.histogram <= 0;
  const macdCrossDown = prevMacd && macd.histogram < 0 && prevMacd.histogram >= 0;
  if (macdCrossUp) score += 2;
  else if (macd.histogram > 0) score += 1;
  else if (macd.histogram < 0) score -= 1;
  if (macdCrossDown) score -= 2;

  const lastClose = closes[closes.length - 1];
  if (lastClose > ma20 && lastClose > ma50) score += 2;
  else if (lastClose > ma20) score += 1;
  else if (lastClose < ma20 && lastClose < ma50) score -= 2;
  else score -= 1;

  return { rsi, macd, ma20, ma50, score, methodology: "technical_composite" };
}

export function scoreToSignal(score: number): { signal: string; reasoning: string } {
  if (score >= 4) return { signal: "STRONG BUY", reasoning: `Composite score +${score}/6: RSI/MACD/MAs align bullish.` };
  if (score >= 1) return { signal: "BUY", reasoning: `Composite score +${score}/6: moderate bullish.` };
  if (score >= -1) return { signal: "HOLD", reasoning: `Composite score ${score}/6: wait for clearer signal.` };
  if (score >= -3) return { signal: "SELL", reasoning: `Composite score ${score}/6: moderate bearish.` };
  return { signal: "STRONG SELL", reasoning: `Composite score ${score}/6: RSI/MACD/MAs align bearish.` };
}
