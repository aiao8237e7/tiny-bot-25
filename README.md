# Tiny Bot — EMA 8/21 Crossover for Solana Hourly Bars

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/aiao8237e7/tiny-bot-25/rank.svg)](https://make.fun/)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/aiao8237e7/tiny-bot-25/reward.svg)](https://make.fun/)

A tiny deterministic paper-trading bot for the make.fun competition
"Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana". It speaks the
agent-fun/bars-replay/v1 protocol over NDJSON on stdin/stdout: the harness
sends `hello`, hourly `batch` messages with bars, fills and the account, and
a final `done`; the bot answers each batch with one `reply` carrying its
orders.

## Strategy

Per symbol, the bot tracks a fast EMA (8 bars) and a slow EMA (21 bars) of
hourly closes. It buys when the fast EMA is above the slow EMA, still
rising, and the price holds above the slow EMA — and it stays out otherwise,
so in a falling market it mostly sits in USDC instead of riding the drop
the way buy-and-hold does. It exits on the reverse crossover, on an 8%
stop-loss from the fill price, or on an 8% trailing stop from the highest
close since entry (v5 replaces the old fixed 25% take-profit, which never
triggered on the dev window).

- One position per symbol, 20% of equity each, at most 5 open at once.
- Regime sizing (v5): while SOL itself is in a downtrend (its fast EMA
  below its slow EMA), new entries are halved to 10% of equity — the bot
  keeps trading through the chop instead of blocking entries outright, so
  it still clears the 8-trade minimum, but risks less where the tape is
  falling. A hard SOL gate was tested and rejected: it scored better on
  the dev window (-75.73 USDC) but only made 5 trades, below the minimum.
- No chasing: no buy after a single-bar jump above +12%.
- A global 12% equity-drawdown halt flattens everything and stops trading.
- Fully deterministic: every decision is a pure function of past closes —
  no randomness, no clock, no network.

## Local practice result (dev window, 136 hourly bars)

- Net PnL: **-120.57 USDC (-1.21%)** on $10,000 capital (v5)
- Buy-and-hold on the same window: **-869.34 USDC (-8.69%)** — the bot
  beats it by **+748.77 USDC**
- 24 trades across 7 symbols, max drawdown 1.76%, Sharpe -0.10
- v4 for comparison: -193.09 USDC, 22 trades, max drawdown 3.00% — v5
  improves net PnL by +72.52 USDC and halves the drawdown, with the same
  entry rules; the gain comes from the regime sizing, not from tuning the
  EMA pair (12/26 and 5/13 both scored worse on this window).

## Run

```sh
node main.ts
```

Node 22.18+ runs the TypeScript directly. The entrypoint is `main.ts` at
the repository root; the license is MIT.
