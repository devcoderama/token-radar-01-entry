# token-radar-01-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/devcoderama/token-radar-01-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/devcoderama/token-radar-01-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A [make.fun](https://make.fun/bounty/token-radar-01) entry for **Build the best token launch radar**.

The program (`main.ts`, Node 22, standard library only) reads the sealed DefiLlama snapshot, scores
every pre-token protocol with a revenue model, and writes the ranked board, the dashboard's data and
the dossier the judge reads.

## The model

Implied value is capitalised fees, from the snapshot's own figures and nothing else:

```
fee_pool  = tvl_usd x 220 bps
revenue   = fee_pool x efficiency x growth_mult x persistence x scale
implied   = round(revenue x 11)
```

- **efficiency** — the protocol's own category: a derivatives market keeps more of its TVL as fees
  than a liquid staking token does (0.5x to 1.8x).
- **growth_mult** — `1 + clamp(change_7d, -60, 120) / 100 x 0.5`, the seven-day TVL move.
- **persistence** — `0.6 + min(age_days, 1095) / 1095 x 0.4`, how long it has run with no token.
- **scale** — `1 + min(chains, 8) / 8 x 0.15`, the chains it runs on.

No protocol name is special-cased: one function scores every row.

## Layout

- `main.ts` — the entrypoint; reads `/input/snapshot.json`, writes `/output`
- `lib/model.ts` — the model, the farm plans, the board and the snapshot parser
- `dashboard/` — the static page: `index.html`, `app.css`, `app.js` (no network, no framework)
- `screenshots/` — the board, a protocol's detail view and a filtered view
- `vendor/makefun-board.ts` — make.fun's own dossier library, vendored unmodified

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

MIT licensed.
