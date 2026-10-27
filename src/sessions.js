import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import pty from 'node-pty';

class RingBuffer {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  push(str) {
    this.chunks.push(str);
    this.size += str.length;
    while (this.size > this.limit && this.chunks.length > 1) {
      this.size -= this.chunks.shift().length;
    }
  }

  toString() {
    return this.chunks.join('');
  }
}

class Session {
  constructor({ kind, cwd, cfg }) {
    this.id = randomUUID();
    this.kind = kind;
    this.cwd = cwd;
    const label = kind === 'agent' ? cfg.agentCommand.split(/\s+/)[0] : 'shell';
    this.name = `${label} · ${basename(cwd) || cwd}`;
    this.createdAt = Date.now();
    this.lastActivity = this.createdAt;
    this.exited = false;
    this.exitCode = null;
    this.clients = new Set();
    this.buffer = new RingBuffer(cfg.scrollbackBytes);

    // Login shell so PATH (~/.local/bin etc.) matches an interactive terminal.
    // For agent sessions, drop into an interactive shell once the agent exits.
    const args = kind === 'agent'
      ? ['-lic', `${cfg.agentCommand}; exec ${cfg.shell} -li`]
      : ['-li'];
    this.pty = pty.spawn(cfg.shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', REMOTE_VIBE: '1' },
    });

    this.pty.onData((data) => {
      this.lastActivity = Date.now();
      this.buffer.push(data);
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(data);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      const msg = `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`;
      this.buffer.push(msg);
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(msg);
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
        }
      }
    });
  }

  attach(ws) {
    this.clients.add(ws);
    const replay = this.buffer.toString();
    if (replay) ws.send(replay);
    if (this.exited) ws.send(JSON.stringify({ type: 'exit', code: this.exitCode }));
  }

  detach(ws) {
    this.clients.delete(ws);
  }

  write(data) {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols, rows) {
    if (this.exited) return;
    cols = Math.max(2, Math.min(500, cols | 0));
    rows = Math.max(2, Math.min(300, rows | 0));
    this.pty.resize(cols, rows);
  }

  kill() {
    if (!this.exited) this.pty.kill('SIGHUP');
    for (const ws of this.clients) ws.close(4000, 'session killed');
    this.clients.clear();
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      exited: this.exited,
      exitCode: this.exitCode,
      clients: this.clients.size,
    };
  }
}

export class SessionManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.sessions = new Map();
  }

  create(kind, cwd) {
    const s = new Session({ kind, cwd, cfg: this.cfg });
    this.sessions.set(s.id, s);
    return s;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    return true;
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }
}
