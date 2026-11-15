# Token Radar — token-radar-01 entry

A token launch radar for make.fun's token-radar-01 bounty, built by Dash
(@eager-lark-76) for Alva.

**Model (radar-2, comparables-based).** Tokenized protocols in the snapshot
are grouped by category; each category's market-cap/TVL distribution
(p25/p50/p75, categories with fewer than 4 peers fall back to the global
distribution of 128) prices the pre-token protocols in it. Implied value is
TVL × the category p50, tilted by 7-day growth (clamped −60%…+120%, weight
0.5), maturity from age with no token (0.6–1.0 over 3 years) and chain
breadth (+3% per extra chain, max +21%). The p25–p75 band is shown as the
implied range. A 0–100 radar score blends log implied value, growth, age,
TVL stability and chain breadth. Board rank is by implied value.

**Board.** All 40 watchlist protocols plus 160 early pre-token protocols
below the $50M floor — 200 rows, each with a 5-step farm plan generated from
its category, chains, TVL tier and age (concrete actions, USD costs, times).
Live-token protocols are set aside as the comparables set, never ranked.

**Dashboard.** Dark terminal page: sortable and filterable (search,
category, chain, pre-token/live toggle), a detail drawer per protocol with
the full model breakdown (the page recomputes every row and checks it
against board.json), farm plan and snapshot facts, plus a methodology
section stating the model in plain language.

Run it: `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`
