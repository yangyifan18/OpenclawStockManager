---
name: a-share-stock
description: |
  Chinese A-share stock analysis for Feishu/OpenClaw. Use when the user mentions stock codes, stock names, fundamentals, auction opening, hot sectors, or capital flow.
---

# A-share Stock Workflow

Use the stock tools instead of guessing.

## Available tools

- `stock_lookup`
- `stock_fundamentals`
- `stock_auction_hotspots`

## When To Use What

### Single-stock fundamentals

If the user gives a stock name or code and asks for analysis:

1. If the query may be ambiguous, call `stock_lookup` first.
2. Call `stock_fundamentals`.
3. Reply in this order:
   - Short conclusion first
   - Core metrics
   - Strengths
   - Risks
   - Data date

If `stock_fundamentals` returns `reason="ambiguous"`, ask the user to pick from the candidate list.

### Auction / hot sectors / capital flow

If the user asks about:

- `集合竞价`
- `竞价`
- `盘前热点`
- `热点板块`
- `资金动向`

Call `stock_auction_hotspots`.

Reply in this order:

1. Opening conclusion in 2-4 sentences
2. Top sectors
3. Representative stocks
4. Capital-style read
5. Risks
6. Data date

## Output Rules

- Never invent numbers.
- Always show the trade date that the tool returned.
- If the tool says it used the latest available date, mention that explicitly.
- The sector summary comes from stock industry labels, not concept boards. Say that when it matters.
- Capital flow here is an inference from auction behavior unless the tool says otherwise.

## Tone

- Keep it concise and trader-like.
- Conclusion first, explanation second.
- No fake certainty.
- End with: `仅供研究，不构成投资建议。`
