// Tiny Bot — EMA crossover paper-trading bot for Solana hourly bars.
// Protocol: agent-fun/bars-replay/v1 over NDJSON on stdin/stdout.
// Strategy: per symbol, buy when the fast EMA (5) crosses above the slow
// EMA (13) while price holds above the slow EMA; exit on the reverse cross,
// on a 5% stop-loss from the fill price, or on a 12% take-profit. One
// position per symbol, at most 20% of equity each, at most 5 open at once.
// A global 12% equity-drawdown halt flattens everything and stops trading.
// Fully deterministic: every decision is a pure function of past closes.

import * as readline from "node:readline";

const FAST_LEN = 5;
const SLOW_LEN = 13;
const MIN_BARS = SLOW_LEN + 2;
const TARGET_WEIGHT_BPS = 2000; // 20% of equity per position
const MAX_POSITIONS = 5;
const STOP_LOSS = 0.95; // sell at -5% from entry
const TAKE_PROFIT = 1.12; // sell at +12% from entry
const MAX_DRAWDOWN_HALT = 0.88; // flatten + halt if equity < 88% of peak
const MAX_SPIKE = 0.12; // do not chase a single-bar jump above +12%
const MAX_SLIPPAGE_BPS = 150;
const MAX_ORDERS_PER_BAR = 16;

type Bar = { symbol: string; t: number; c: string };
type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

type SymState = {
  scale: number;
  closes: number[];
  lastT: number;
  emaFast: number;
  emaSlow: number;
  prevFast: number;
  entry: number; // fill price of the open position, 0 when flat
  hasPosition: boolean;
};

const symbols = new Map<string, SymState>();
let warmupBars = 1;
let capitalUnits = 0n;
let peakEquity = 0n;
let halted = false;
let orderSeq = 0;

function emaAlpha(len: number): number {
  return 2 / (len + 1);
}

function toPrice(raw: string, scale: number): number {
  return Number(raw) / 10 ** scale;
}

function onFill(symbol: string, side: string, status: string, priceRaw: string): void {
  if (status !== "filled") return;
  const st = symbols.get(symbol);
  if (!st) return;
  if (side === "buy") st.entry = toPrice(priceRaw, st.scale);
  if (side === "sell") st.entry = 0;
}

function decide(bar: Bar, cash: bigint, equity: bigint, positions: Map<string, bigint>): Order[] {
  const st = symbols.get(bar.symbol);
  if (!st || halted) return [];
  const close = toPrice(bar.c, st.scale);
  if (bar.t <= st.lastT) return [];
  st.lastT = bar.t;
  if (st.closes.length === 0) {
    st.emaFast = close;
    st.emaSlow = close;
    st.prevFast = close;
  } else {
    st.prevFast = st.emaFast;
    st.emaFast = close * emaAlpha(FAST_LEN) + st.emaFast * (1 - emaAlpha(FAST_LEN));
    st.emaSlow = close * emaAlpha(SLOW_LEN) + st.emaSlow * (1 - emaAlpha(SLOW_LEN));
  }
  st.closes.push(close);
  if (st.closes.length > 400) st.closes.shift();
  // Trade only after the harness warmup and after the slow EMA is seeded.
  if (st.closes.length < Math.max(MIN_BARS, warmupBars)) return [];

  const qty = positions.get(bar.symbol) ?? 0n;
  const holding = qty > 0n;
  st.hasPosition = holding;

  // Exits first: stop-loss, take-profit, trend reversal.
  if (holding && st.entry > 0) {
    if (close <= st.entry * STOP_LOSS || close >= st.entry * TAKE_PROFIT) {
      return [{ side: "sell", client_id: `s${orderSeq++}-${bar.symbol}`, symbol: bar.symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  if (holding && st.emaFast < st.emaSlow) {
    return [{ side: "sell", client_id: `s${orderSeq++}-${bar.symbol}`, symbol: bar.symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // Entries: fast above slow, rising fast EMA, price above slow EMA.
  if (holding) return [];
  if (positions.size >= MAX_POSITIONS) return [];
  if (st.emaFast <= st.emaSlow) return [];
  if (st.emaFast <= st.prevFast) return [];
  if (close <= st.emaSlow) return [];
  const prevClose = st.closes[st.closes.length - 2];
  if (prevClose > 0 && close / prevClose - 1 > MAX_SPIKE) return [];

  const notional = (equity * BigInt(TARGET_WEIGHT_BPS)) / 10000n;
  if (notional <= 0n || cash < notional / 2n) return [];
  const spend = notional < cash ? notional : cash;
  return [{ side: "buy", client_id: `b${orderSeq++}-${bar.symbol}`, symbol: bar.symbol, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function handleBatch(msg: any): void {
  const seq = msg.seq as number;
  const fills = Array.isArray(msg.fills) ? msg.fills : [];
  for (const f of fills) onFill(f.symbol, f.side, f.status, f.price);
  const account = msg.account ?? {};
  const cash = BigInt(account.cash_quote_units ?? "0");
  const equity = BigInt(account.equity_quote_units ?? "0");
  if (capitalUnits === 0n) capitalUnits = equity;
  if (equity > peakEquity) peakEquity = equity;
  const positions = new Map<string, bigint>();
  for (const p of account.positions ?? []) {
    positions.set(p.symbol, BigInt(p.qty));
  }
  // Global drawdown halt: flatten everything once, then stay out.
  const orders: Order[] = [];
  if (!halted && peakEquity > 0n && equity * 100n < peakEquity * 88n) {
    halted = true;
    for (const [symbol, qty] of positions) {
      if (qty > 0n) {
        orders.push({ side: "sell", client_id: `h${orderSeq++}-${symbol}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
  } else if (!halted) {
    const bars: Bar[] = Array.isArray(msg.bars) ? msg.bars : [];
    const seen = new Set<string>();
    for (const bar of bars) {
      const key = `${bar.symbol}:${bar.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const st = symbols.get(bar.symbol);
      if (!st) continue;
      if (orders.length >= MAX_ORDERS_PER_BAR) break;
      orders.push(...decide(bar, cash, equity, positions));
    }
  }
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  let barCount = 0;
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (typeof msg.warmup_bars === "number") warmupBars = msg.warmup_bars;
      if (msg.capital && msg.capital.quote_units) capitalUnits = BigInt(msg.capital.quote_units);
      for (const s of msg.symbols ?? []) {
        symbols.set(s.symbol, {
          scale: s.price_scale,
          closes: [],
          lastT: -1,
          emaFast: 0,
          emaSlow: 0,
          prevFast: 0,
          entry: 0,
          hasPosition: false,
        });
      }
      return;
    }
    if (msg.type === "batch") {
      barCount += 1;
      handleBatch(msg);
      return;
    }
    if (msg.type === "done") {
      rl.close();
      process.exit(0);
    }
  });
}

main();
