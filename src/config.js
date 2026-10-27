import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'remote-vibe');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7681,
  projectsRoot: join(homedir(), 'dev'),
  shell: process.env.SHELL || '/bin/bash',
  // Command started by "agent" sessions, e.g. 'claude', 'codex', 'aider', 'gemini'.
  agentCommand: 'claude',
  scrollbackBytes: 1024 * 1024,
  // Extra hostnames allowed in Host/Origin besides localhost and the Tailscale name.
  extraHosts: [],
};

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

export function loadConfig() {
  let stored = {};
  if (existsSync(CONFIG_PATH)) stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const cfg = { ...DEFAULTS, ...stored };
  if (!cfg.token) {
    cfg.token = newToken();
    saveConfig(cfg);
  }
  return cfg;
}
