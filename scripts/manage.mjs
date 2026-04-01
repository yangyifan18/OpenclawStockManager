#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "stock-tools";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OPENCLAW_HOME = path.join(os.homedir(), ".openclaw");
const STATE_DIRNAME = ".stock-tools";
const STATE_FILE_NAME = "install-state.json";
const MAC_LAUNCH_AGENT_ID = "ai.openclaw.stock-tools.autoupdate";
const CRON_MARKER = "# openclaw-stock-tools-autoupdate";
const SYNC_EXCLUDES = new Set([
  ".git",
  ".github",
  "docs",
  "scripts",
  "node_modules",
  ".DS_Store",
]);

const usage = `Usage:
  node scripts/manage.mjs install [--source <path>] [--openclaw-home <path>] [--no-restart]
  node scripts/manage.mjs update [--openclaw-home <path>] [--skip-git] [--no-restart] [--quiet]
  node scripts/manage.mjs enable-autoupdate [--openclaw-home <path>] [--interval-hours <n>]
  node scripts/manage.mjs disable-autoupdate [--openclaw-home <path>]
  node scripts/manage.mjs status [--openclaw-home <path>]
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }

  const options = parseArgs(rest);
  const openclawHome = path.resolve(options.openclawHome ?? process.env.OPENCLAW_HOME ?? DEFAULT_OPENCLAW_HOME);

  switch (command) {
    case "install":
      await install({
        openclawHome,
        sourcePath: path.resolve(options.source ?? REPO_ROOT),
        restart: !options.noRestart,
        quiet: options.quiet,
      });
      break;
    case "update":
      await update({
        openclawHome,
        restart: !options.noRestart,
        quiet: options.quiet,
        skipGit: options.skipGit,
      });
      break;
    case "enable-autoupdate":
      await enableAutoUpdate({
        openclawHome,
        intervalHours: Number(options.intervalHours ?? 6),
      });
      break;
    case "disable-autoupdate":
      await disableAutoUpdate({ openclawHome });
      break;
    case "status":
      await printStatus({ openclawHome });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function install(params) {
  const sourcePath = path.resolve(params.sourcePath);
  ensurePluginSource(sourcePath);

  const extensionDir = path.join(params.openclawHome, "extensions", PLUGIN_ID);
  syncPlugin(sourcePath, extensionDir);
  configureOpenClaw(params.openclawHome);
  installWrapper(params.openclawHome, sourcePath);
  writeState(params.openclawHome, {
    pluginId: PLUGIN_ID,
    sourcePath,
    installedAt: new Date().toISOString(),
    git: readGitMetadata(sourcePath),
  });

  if (params.restart) {
    restartGateway(params.quiet);
  }

  if (!params.quiet) {
    process.stdout.write(
      [
        `Installed ${PLUGIN_ID} from ${sourcePath}`,
        `Runtime path: ${extensionDir}`,
        `Control command: ${path.join(params.openclawHome, "bin", "stock-toolsctl")}`,
      ].join("\n") + "\n",
    );
  }
}

async function update(params) {
  const state = readState(params.openclawHome);
  if (!state) {
    throw new Error("No stock-tools install state found. Run install first.");
  }

  const sourcePath = path.resolve(state.sourcePath);
  ensurePluginSource(sourcePath);

  if (!params.skipGit && isGitRepository(sourcePath)) {
    pullGitSource(sourcePath, params.quiet);
  }

  const extensionDir = path.join(params.openclawHome, "extensions", PLUGIN_ID);
  syncPlugin(sourcePath, extensionDir);
  configureOpenClaw(params.openclawHome);
  installWrapper(params.openclawHome, sourcePath);
  writeState(params.openclawHome, {
    ...state,
    sourcePath,
    updatedAt: new Date().toISOString(),
    git: readGitMetadata(sourcePath),
  });

  if (params.restart) {
    restartGateway(params.quiet);
  }

  if (!params.quiet) {
    process.stdout.write(`Updated ${PLUGIN_ID} from ${sourcePath}\n`);
  }
}

async function enableAutoUpdate(params) {
  const state = readState(params.openclawHome);
  if (!state) {
    throw new Error("No stock-tools install state found. Run install first.");
  }

  const sourcePath = path.resolve(state.sourcePath);
  if (!isGitRepository(sourcePath)) {
    throw new Error("Auto-update requires the source checkout to be a git repository.");
  }

  const intervalHours = Math.max(1, Math.floor(params.intervalHours || 6));
  if (process.platform === "darwin") {
    installLaunchAgent(params.openclawHome, sourcePath, intervalHours);
    process.stdout.write(`Enabled auto-update via launchd every ${intervalHours}h.\n`);
    return;
  }

  installCronJob(params.openclawHome, sourcePath, intervalHours);
  process.stdout.write(`Enabled auto-update via cron every ${intervalHours}h.\n`);
}

async function disableAutoUpdate(params) {
  if (process.platform === "darwin") {
    removeLaunchAgent();
    process.stdout.write("Disabled auto-update launchd job.\n");
    return;
  }

  removeCronJob();
  process.stdout.write("Disabled auto-update cron job.\n");
}

async function printStatus(params) {
  const state = readState(params.openclawHome);
  const extensionDir = path.join(params.openclawHome, "extensions", PLUGIN_ID);

  if (!state) {
    process.stdout.write(`No install state found for ${PLUGIN_ID}.\n`);
    return;
  }

  const lines = [
    `Plugin: ${PLUGIN_ID}`,
    `Source: ${state.sourcePath}`,
    `Runtime: ${extensionDir}`,
    `Git repo: ${isGitRepository(state.sourcePath) ? "yes" : "no"}`,
    `Installed at: ${state.installedAt ?? "unknown"}`,
  ];

  if (state.updatedAt) {
    lines.push(`Updated at: ${state.updatedAt}`);
  }
  if (state.git?.branch) {
    lines.push(`Branch: ${state.git.branch}`);
  }
  if (state.git?.remote) {
    lines.push(`Remote: ${state.git.remote}`);
  }
  if (process.platform === "darwin") {
    lines.push(`Auto-update: ${fs.existsSync(getLaunchAgentPath()) ? "enabled" : "disabled"}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source" || arg === "--openclaw-home" || arg === "--interval-hours") {
      options[toCamelCase(arg.slice(2))] = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "--no-restart") {
      options.noRestart = true;
      continue;
    }
    if (arg === "--skip-git") {
      options.skipGit = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function ensurePluginSource(sourcePath) {
  const required = ["index.ts", "openclaw.plugin.json", "src", "skills"];
  for (const entry of required) {
    if (!fs.existsSync(path.join(sourcePath, entry))) {
      throw new Error(`Plugin source is missing ${entry}: ${sourcePath}`);
    }
  }
}

function syncPlugin(sourcePath, extensionDir) {
  fs.rmSync(extensionDir, { recursive: true, force: true });
  fs.mkdirSync(extensionDir, { recursive: true });

  for (const entry of fs.readdirSync(sourcePath)) {
    if (SYNC_EXCLUDES.has(entry)) continue;
    fs.cpSync(path.join(sourcePath, entry), path.join(extensionDir, entry), {
      recursive: true,
    });
  }
}

function configureOpenClaw(openclawHome) {
  const configPath = path.join(openclawHome, "openclaw.json");
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};

  config.plugins ??= {};
  config.plugins.allow = mergeStringArray(config.plugins.allow, [PLUGIN_ID]);
  config.plugins.entries ??= {};
  config.plugins.entries[PLUGIN_ID] ??= {};
  config.plugins.entries[PLUGIN_ID].enabled = true;

  fs.mkdirSync(openclawHome, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function mergeStringArray(current, extra) {
  const merged = new Set(Array.isArray(current) ? current.filter((value) => typeof value === "string") : []);
  for (const value of extra) merged.add(value);
  return [...merged];
}

function installWrapper(openclawHome, sourcePath) {
  const binDir = path.join(openclawHome, "bin");
  const wrapperPath = path.join(binDir, "stock-toolsctl");
  fs.mkdirSync(binDir, { recursive: true });

  const content = `#!/usr/bin/env bash
set -euo pipefail
OPENCLAW_HOME="\${OPENCLAW_HOME:-${escapeDoubleQuotes(openclawHome)}}"
exec node "${escapeDoubleQuotes(path.join(sourcePath, "scripts", "manage.mjs"))}" "$@"
`;
  fs.writeFileSync(wrapperPath, content, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
}

function writeState(openclawHome, state) {
  const stateDir = path.join(openclawHome, STATE_DIRNAME);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, STATE_FILE_NAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function readState(openclawHome) {
  const statePath = path.join(openclawHome, STATE_DIRNAME, STATE_FILE_NAME);
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function readGitMetadata(sourcePath) {
  if (!isGitRepository(sourcePath)) return null;
  const branch = runGit(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"], true).trim();
  const remote = readGitRemote(sourcePath);
  const commit = runGit(sourcePath, ["rev-parse", "HEAD"], true).trim();
  return {
    branch: branch || undefined,
    remote: remote || undefined,
    commit: commit || undefined,
  };
}

function isGitRepository(sourcePath) {
  return fs.existsSync(path.join(sourcePath, ".git"));
}

function pullGitSource(sourcePath, quiet) {
  const remote = readGitRemote(sourcePath);
  if (!remote) return;

  const branch = runGit(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"], true).trim();
  runGit(sourcePath, ["fetch", "--tags", "origin"], quiet);
  if (branch && branch !== "HEAD") {
    runGit(sourcePath, ["pull", "--ff-only", "origin", branch], quiet);
  }
}

function readGitRemote(sourcePath) {
  try {
    return runGit(sourcePath, ["remote", "get-url", "origin"], true).trim();
  } catch {
    return "";
  }
}

function runGit(cwd, args, quiet) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function restartGateway(quiet) {
  try {
    execFileSync("openclaw", ["gateway", "restart"], {
      encoding: "utf8",
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (error) {
    if (!quiet) {
      process.stderr.write(`Gateway restart skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

function installLaunchAgent(openclawHome, sourcePath, intervalHours) {
  const plistPath = getLaunchAgentPath();
  const updateCommand = `OPENCLAW_HOME="${escapeXml(openclawHome)}" node "${escapeXml(
    path.join(sourcePath, "scripts", "manage.mjs"),
  )}" update --quiet`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${MAC_LAUNCH_AGENT_ID}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>-lc</string>
      <string>${updateCommand}</string>
    </array>
    <key>StartInterval</key>
    <integer>${intervalHours * 3600}</integer>
    <key>RunAtLoad</key>
    <true/>
  </dict>
</plist>
`;

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, "utf8");

  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], {
      stdio: "ignore",
    });
  } catch {
    // Ignore: the job may not exist yet.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], {
    stdio: "ignore",
  });
  execFileSync("launchctl", ["enable", `gui/${process.getuid()}/${MAC_LAUNCH_AGENT_ID}`], {
    stdio: "ignore",
  });
}

function removeLaunchAgent() {
  const plistPath = getLaunchAgentPath();
  if (!fs.existsSync(plistPath)) return;

  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], {
      stdio: "ignore",
    });
  } catch {
    // Ignore: the job may already be unloaded.
  }
  fs.rmSync(plistPath, { force: true });
}

function getLaunchAgentPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LAUNCH_AGENT_ID}.plist`);
}

function installCronJob(openclawHome, sourcePath, intervalHours) {
  const minute = 17;
  const hourPattern = intervalHours >= 24 ? "0" : `*/${intervalHours}`;
  const command = `${minute} ${hourPattern} * * * OPENCLAW_HOME="${openclawHome}" /usr/bin/env node "${path.join(
    sourcePath,
    "scripts",
    "manage.mjs",
  )}" update --quiet >/tmp/openclaw-stock-tools-autoupdate.log 2>&1 ${CRON_MARKER}`;
  const existing = readCrontab();
  const filtered = existing.filter((line) => !line.includes(CRON_MARKER));
  filtered.push(command);
  writeCrontab(filtered);
}

function removeCronJob() {
  const existing = readCrontab();
  writeCrontab(existing.filter((line) => !line.includes(CRON_MARKER)));
}

function readCrontab() {
  try {
    const output = execFileSync("crontab", ["-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeCrontab(lines) {
  const body = `${lines.join("\n")}\n`;
  execFileSync("crontab", ["-"], { input: body, encoding: "utf8" });
}

function escapeDoubleQuotes(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
