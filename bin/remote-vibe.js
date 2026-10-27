#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import { loadConfig, saveConfig, newToken, CONFIG_PATH } from '../src/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function tailscaleName() {
  try {
    const status = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' }));
    return status.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function pair(cfg) {
  const ts = tailscaleName();
  const usbUrl = `http://localhost:${cfg.port}/#token=${cfg.token}`;
  if (ts) {
    const url = `https://${ts}/#token=${cfg.token}`;
    console.log('\nRemote (Tailscale): scan with your phone camera\n');
    qrcode.generate(url, { small: true });
    console.log(url);
    console.log(`\nMake sure Tailscale is proxying to the server:  tailscale serve --bg ${cfg.port}`);
  } else {
    console.log('\nTailscale not detected (is tailscaled running and logged in?).');
  }
  console.log('\nUSB (after `adb reverse tcp:%d tcp:%d`):\n', cfg.port, cfg.port);
  qrcode.generate(usbUrl, { small: true });
  console.log(usbUrl + '\n');
  console.log('Keep this token secret: it gives full shell access to this PC.');
}

function installService() {
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]
Description=remote-vibe phone terminal server
After=network-online.target

[Service]
ExecStart=${process.execPath} ${join(ROOT, 'bin', 'remote-vibe.js')} start
WorkingDirectory=${homedir()}
Environment=SHELL=${process.env.SHELL || '/bin/bash'}
Environment=PATH=${process.env.PATH}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
  const unitPath = join(unitDir, 'remote-vibe.service');
  writeFileSync(unitPath, unit);
  console.log(`Wrote ${unitPath}`);
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  execFileSync('systemctl', ['--user', 'enable', '--now', 'remote-vibe.service'], { stdio: 'inherit' });
  console.log('Service enabled and started.');
  console.log(`To keep it running after logout / start at boot:  sudo loginctl enable-linger ${process.env.USER}`);
}

const cmd = process.argv[2] || 'start';
const cfg = loadConfig();

switch (cmd) {
  case 'start': {
    const { startServer } = await import('../src/server.js');
    startServer(cfg);
    break;
  }
  case 'pair':
    pair(cfg);
    break;
  case 'rotate-token':
    cfg.token = newToken();
    saveConfig(cfg);
    console.log('Token rotated. Restart the server (systemctl --user restart remote-vibe) and re-pair your phone.');
    break;
  case 'install-service':
    installService();
    break;
  case 'config':
    console.log(CONFIG_PATH);
    break;
  default:
    console.log(`usage: remote-vibe [start|pair|rotate-token|install-service|config]`);
    process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
