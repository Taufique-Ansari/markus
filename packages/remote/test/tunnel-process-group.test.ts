import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { spawnDetached } from '../src/process-group.js';

/**
 * Real-process evidence that {@link spawnDetached} does what its docstring
 * claims: it line-buffers output AND it can take down a whole process tree.
 * The "kill only the direct child" bug is invisible in unit fakes — it only
 * shows up against the OS, so we exercise the OS here.
 */
const posix = process.platform !== 'win32';

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

function countGroup(pgid: number): number {
  try {
    return Number(execSync(`pgrep -g ${pgid} | wc -l`).toString().trim());
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

describe.skipIf(!posix)('spawnDetached — process-group hygiene', () => {
  it('line-buffers stdout and stderr into complete lines', async () => {
    const lines: Array<{ line: string; stream: string }> = [];
    const code = await new Promise<number | null>((resolve) => {
      spawnDetached('/bin/sh', ['-c', "printf 'one\\ntwo\\n'; printf 'err1\\n' 1>&2"], {
        onLine: (line, stream) => lines.push({ line, stream }),
        onExit: (c) => resolve(c),
      });
    });
    expect(code).toBe(0);
    expect(lines).toContainEqual({ line: 'one', stream: 'stdout' });
    expect(lines).toContainEqual({ line: 'two', stream: 'stdout' });
    expect(lines).toContainEqual({ line: 'err1', stream: 'stderr' });
  });

  it('kill() takes down the whole process group, including grandchildren', async () => {
    // A shell that forks two background sleeps (grandchildren) and waits.
    const proc = spawnDetached('/bin/sh', ['-c', 'sleep 300 & sleep 300 & wait'], {});
    const pgid = proc.pid!;
    expect(pgid).toBeGreaterThan(0);

    // Wait until the group actually has members (shell + sleeps).
    await waitFor(() => countGroup(pgid) >= 1);
    const before = countGroup(pgid);
    expect(before).toBeGreaterThanOrEqual(1);

    proc.kill('SIGKILL');

    await waitFor(() => countGroup(pgid) === 0);
    expect(countGroup(pgid)).toBe(0); // no zombie tunnel survivors
  }, 15_000);
});
