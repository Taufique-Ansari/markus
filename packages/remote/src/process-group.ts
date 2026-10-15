/**
 * Process-group spawning for tunnel binaries (T6).
 *
 * ── Why a dedicated helper ───────────────────────────────────────────────────
 *
 * A tunnel binary is a long-lived child that itself may fork helpers. If we
 * spawn it normally and later `child.kill()`, only the direct child dies: the
 * grand-children keep the tunnel open and the port bound — a ZOMBIE tunnel that
 * survives "stop", leaks a public URL, and blocks the next start on the same
 * port. The fix is to put the child in its OWN process group and signal the
 * whole group (`kill(-pid)`), which the platform shell tool already had to
 * learn the hard way.
 *
 * We also line-buffer stdout/stderr so the caller gets complete log lines to
 * feed the URL parser, regardless of how the OS chunks the stream.
 *
 * This module is the ONLY place that talks to `node:child_process` for tunnels,
 * so replacing spawn in tests is a single injection point.
 */

import { spawn } from 'node:child_process';

export interface TunnelProcess {
  /** OS pid of the direct child (undefined if spawn failed synchronously). */
  readonly pid: number | undefined;
  /** True once the process has exited (or was killed). */
  readonly exited: boolean;
  /** Signal the whole process group (falling back to the direct child). */
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Receives complete lines (newline stripped) as they are produced. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Fired exactly once when the process exits. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Injectable spawn signature (tests pass a fake; production uses {@link spawnDetached}). */
export type SpawnFn = (bin: string, args: string[], opts: SpawnOptions) => TunnelProcess;

function makeLineSplitter(onLine: (line: string, stream: 'stdout' | 'stderr') => void, stream: 'stdout' | 'stderr') {
  let buffer = '';
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line, stream);
    }
    // Guard against a binary that never emits a newline but floods output.
    if (buffer.length > 64 * 1024) {
      onLine(buffer, stream);
      buffer = '';
    }
  };
}

/**
 * Spawn `bin args…` in its own process group so {@link TunnelProcess.kill} can
 * take down the whole tree. stdout/stderr are piped and line-split.
 */
export const spawnDetached: SpawnFn = (bin, args, opts) => {
  // `detached: true` → setsid() on POSIX / CREATE_NEW_PROCESS_GROUP on Windows,
  // giving the child its own group id equal to its pid.
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    opts.onExit?.(code, signal);
  };

  if (opts.onLine) {
    child.stdout?.on('data', makeLineSplitter(opts.onLine, 'stdout'));
    child.stderr?.on('data', makeLineSplitter(opts.onLine, 'stderr'));
  }
  child.on('exit', (code, signal) => finish(code, signal as NodeJS.Signals | null));
  child.on('error', () => finish(null, null));

  const handle: TunnelProcess = {
    pid: child.pid,
    get exited() {
      return exited;
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (exited) return;
      const pid = child.pid;
      if (process.platform === 'win32') {
        // Windows has no negative-pid group kill; taskkill /T walks the tree.
        try {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {
          /* best effort */
        }
        return;
      }
      if (pid === undefined) return;
      try {
        // Negative pid → signal every member of the child's process group.
        process.kill(-pid, signal);
      } catch {
        // Group already gone (ESRCH) or not a group leader — fall back.
        try {
          process.kill(pid, signal);
        } catch {
          /* already dead */
        }
      }
    },
  };
  return handle;
};
