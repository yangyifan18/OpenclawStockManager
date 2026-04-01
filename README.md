# Stock Tools for OpenClaw

An OpenClaw extension for A-share stock lookup, fundamentals, official CNINFO report analysis, and opening-auction hotspot analysis.

This repository is meant to be the GitHub source of the plugin. OpenClaw loads the runtime copy from `~/.openclaw/extensions/stock-tools`, and the install/update scripts in this repo keep that runtime copy in sync.

## What It Does

- `stock_lookup`
  Resolve an A-share stock name or code.
- `stock_fundamentals`
  Return a fundamentals snapshot.
- `stock_reports`
  Return official CNINFO periodic reports and earnings disclosures.
- `stock_auction_hotspots`
  Analyze opening auction leaders and sector heat. This path still requires TuShare data.

The extension also exposes:

- `/stock-fund`
- `/stock-report`
- `/stock-auction`

## Requirements

- OpenClaw installed and working locally.
- Node.js available in the shell.
- Optional: Feishu channel already configured in OpenClaw if you want to use the plugin from Feishu group chats.
- Optional: `TUSHARE_TOKEN` configured in `~/.openclaw/stock-tools.env` if you want auction analysis and richer fundamentals.

## Install

Clone the repository wherever you want to maintain it, then install it into OpenClaw:

```bash
git clone https://github.com/<your-org-or-user>/openclaw-stock-tools.git
cd openclaw-stock-tools
./scripts/install.sh
```

What the installer does:

- syncs the plugin into `~/.openclaw/extensions/stock-tools`
- updates `~/.openclaw/openclaw.json` so `stock-tools` is allowed and enabled
- installs a helper command at `~/.openclaw/bin/stock-toolsctl`
- restarts `openclaw gateway` if available

If your OpenClaw home is not `~/.openclaw`, pass it explicitly:

```bash
./scripts/install.sh --openclaw-home /path/to/.openclaw
```

## Update

If the source checkout is a git repo, updates are:

```bash
~/.openclaw/bin/stock-toolsctl update
```

That command will:

- run `git fetch` + `git pull --ff-only` in the source checkout
- resync the runtime extension
- restart the gateway

If the source checkout has no `origin` yet, the updater will skip `git pull` and only resync the local files.

If you already did `git pull` yourself and only want to resync:

```bash
~/.openclaw/bin/stock-toolsctl update --skip-git
```

## Auto Update

Enable background updates:

```bash
~/.openclaw/bin/stock-toolsctl enable-autoupdate
```

Disable them:

```bash
~/.openclaw/bin/stock-toolsctl disable-autoupdate
```

Current behavior:

- macOS: installs a `launchd` job
- Linux: installs a user `crontab` entry

Default interval is every 6 hours. Override it if needed:

```bash
~/.openclaw/bin/stock-toolsctl enable-autoupdate --interval-hours 12
```

## Feishu

This plugin does not replace the Feishu extension. It plugs into an existing OpenClaw runtime.

If OpenClaw already has Feishu enabled, once this plugin is installed the agent can call stock tools from Feishu chats and group mentions.

Example prompts:

```text
@bot 分析一下 600519
@bot 分析一下 锐新科技
@bot 看一下中芯国际最近季报和业绩披露
@bot 看今天集合竞价热点和资金动向
```

## Data Sources

- Public quote fallback for basic fundamentals
- CNINFO for official periodic reports and earnings disclosures
- TuShare for auction and richer quantitative snapshots

## Development Flow

Make changes in this repo, then sync them into OpenClaw:

```bash
./scripts/install.sh --no-restart
openclaw gateway restart
```

Check current install metadata:

```bash
~/.openclaw/bin/stock-toolsctl status
```
