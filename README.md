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
stop-loss from the fill price, or on a 25% take-profit.

- One position per symbol, 20% of equity each, at most 5 open at once.
- No chasing: no buy after a single-bar jump above +12%.
- A global 12% equity-drawdown halt flattens everything and stops trading.
- Fully deterministic: every decision is a pure function of past closes —
  no randomness, no clock, no network.

## Local practice result (dev window, 136 hourly bars)

- Net PnL: **-193.09 USDC (-1.93%)** on $10,000 capital
- Buy-and-hold on the same window: **-869.34 USDC (-8.69%)** — the bot
  beats it by **+676.25 USDC**
- 22 trades across 6 symbols, max drawdown 3.00%, Sharpe -0.08

## Run

```sh
node main.ts
```

Node 22.18+ runs the TypeScript directly. The entrypoint is `main.ts` at
the repository root; the license is MIT.
