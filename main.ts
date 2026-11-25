// Tiny Bot — EMA crossover paper-trading bot for Solana hourly bars.
// Protocol: agent-fun/bars-replay/v1 over NDJSON on stdin/stdout.
// Strategy: per symbol, buy when the fast EMA (8) sits above the slow EMA
// (21) and is still rising, with price above the slow EMA; exit on the
// reverse cross, on an 8% stop-loss from the fill price, or on a 25%
// take-profit. One position per symbol, 20% of equity each, at most 5 open
// at once. A global 12% equity-drawdown halt flattens everything and stops
// trading. Fully deterministic: every decision is a pure function of past
// closes.

import * as readline from "node:readline";

const FAST_LEN = 8;
const SLOW_LEN = 21;
const MIN_BARS = SLOW_LEN + 2;
const TARGET_WEIGHT_BPS = 2000; // 20% of equity per position
const MAX_POSITIONS = 5;
const STOP_LOSS = 0.92; // sell at -8% from entry
const TAKE_PROFIT = 1.25; // sell at +25% from entry
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
};

const symbols = new Map<string, SymState>();
let warmupBars = 1;
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

// Record one new bar; returns false when the bar is stale or unknown.
function ingest(bar: Bar): boolean {
  const st = symbols.get(bar.symbol);
  if (!st || bar.t <= st.lastT) return false;
  st.lastT = bar.t;
  const close = toPrice(bar.c, st.scale);
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
  return true;
}

function decide(symbol: string, cash: bigint, equity: bigint, positions: Map<string, bigint>): Order[] {
  const st = symbols.get(symbol);
  if (!st || halted) return [];
  if (st.closes.length < Math.max(MIN_BARS, warmupBars)) return [];
  const close = st.closes[st.closes.length - 1];
  const qty = positions.get(symbol) ?? 0n;
  const holding = qty > 0n;

  // Exits first: stop-loss, take-profit, trend reversal.
  if (holding && st.entry > 0) {
    if (close <= st.entry * STOP_LOSS || close >= st.entry * TAKE_PROFIT) {
      return [{ side: "sell", client_id: `s${orderSeq++}-${symbol}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  if (holding && st.emaFast < st.emaSlow) {
    return [{ side: "sell", client_id: `s${orderSeq++}-${symbol}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
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
  return [{ side: "buy", client_id: `b${orderSeq++}-${symbol}`, symbol, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function handleBatch(msg: any): void {
  const seq = msg.seq as number;
  const fills = Array.isArray(msg.fills) ? msg.fills : [];
  for (const f of fills) onFill(f.symbol, f.side, f.status, f.price);
  const account = msg.account ?? {};
  const cash = BigInt(account.cash_quote_units ?? "0");
  const equity = BigInt(account.equity_quote_units ?? "0");
  if (equity > peakEquity) peakEquity = equity;
  const positions = new Map<string, bigint>();
  for (const p of account.positions ?? []) {
    positions.set(p.symbol, BigInt(p.qty));
  }
  // Ingest every bar first so the regime filter sees this batch's SOL bar.
  const bars: Bar[] = Array.isArray(msg.bars) ? msg.bars : [];
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const bar of bars) {
    const key = `${bar.symbol}:${bar.t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ingest(bar)) fresh.push(bar.symbol);
  }
  const orders: Order[] = [];
  // Global drawdown halt: flatten everything once, then stay out.
  if (!halted && peakEquity > 0n && equity * 100n < peakEquity * 88n) {
    halted = true;
    for (const [symbol, qty] of positions) {
      if (qty > 0n) {
        orders.push({ side: "sell", client_id: `h${orderSeq++}-${symbol}`, symbol, qty: qty.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
  } else if (!halted) {
    for (const symbol of fresh) {
      if (orders.length >= MAX_ORDERS_PER_BAR) break;
      orders.push(...decide(symbol, cash, equity, positions));
    }
  }
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
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
      for (const s of msg.symbols ?? []) {
        symbols.set(s.symbol, {
          scale: s.price_scale,
          closes: [],
          lastT: -1,
          emaFast: 0,
          emaSlow: 0,
          prevFast: 0,
          entry: 0,
        });
      }
      return;
    }
    if (msg.type === "batch") {
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
