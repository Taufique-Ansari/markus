/**
 * Path B — "hand the tunnel setup to an Agent" plan builder (T10).
 *
 * The wizard never sends free-form prose to an Agent. It sends this file's
 * output: a frozen {@link AgentTunnelTaskContract} (`goal` / `commands` /
 * `successCriteria` / `rollback`, T1 §7) plus the deterministic dispatch prompt
 * that tells the Agent exactly how to execute it.
 *
 * Why a builder and not inline strings in the API server: the same plan is
 *   • shown to the user in the wizard (they consent to *these* commands),
 *   • executed by the Agent's shell tool, and
 *   • asserted against by the end-to-end harness.
 * One builder ⇒ those three can never disagree.
 *
 * Pure + dependency-free (no `node:*`, no I/O) so it is trivially unit-testable
 * and safe to import from the CLI/api-server wiring.
 */
import type {
  AgentTunnelTaskCommand,
  AgentTunnelTaskContract,
  AgentTunnelTaskRollbackStep,
  AgentTunnelTaskSuccessCriterion,
  RemoteEndpointKind,
} from './contract.js';

/** Bump when the emitted plan changes shape (prompt/commands/criteria). */
export const AGENT_SETUP_PLAN_VERSION = '1.1.0';

export const AGENT_SETUP_PLATFORMS = ['macos', 'linux', 'windows'] as const;
export type AgentSetupPlatform = (typeof AGENT_SETUP_PLATFORMS)[number];

/** Default local Markus API port the tunnel must target. */
export const DEFAULT_LOCAL_API_PORT = 8056;

export interface AgentSetupPlanInput {
  kind: RemoteEndpointKind;
  platform: AgentSetupPlatform;
  /** Local Markus API port the tunnel points at (a loopback address, never 0.0.0.0). */
  localPort?: number;
  /** Display name registered with the Hub. */
  instanceName?: string;
  /** Hub login username — when present, adds an entry-reachability criterion. */
  username?: string;
  /** Hub base URL (default `https://www.markus.global`). */
  hubUrl?: string;
}

export interface AgentSetupPlan {
  contract: AgentTunnelTaskContract;
  /** Deterministic prompt to dispatch to the chosen Agent. */
  prompt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Install lines (mirrors the providers' consent-gated install plan, flattened
// to the platform the user actually runs).
// ─────────────────────────────────────────────────────────────────────────────

function installRun(kind: RemoteEndpointKind, platform: AgentSetupPlatform): string | null {
  const cf =
    platform === 'macos'
      ? 'brew install cloudflared'
      : platform === 'windows'
        ? 'winget install --id Cloudflare.cloudflared -e'
        : 'curl -fL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared';
  const ts =
    platform === 'macos'
      ? 'brew install tailscale'
      : platform === 'windows'
        ? 'winget install --id Tailscale.Tailscale -e'
        : 'curl -fsSL https://tailscale.com/install.sh | sh';
  switch (kind) {
    case 'cloudflare_quick':
    case 'cloudflare_named':
      return cf;
    case 'tailscale_funnel':
    case 'tailscale_serve':
      return ts;
    case 'custom':
      return null; // the user already runs their own proxy
  }
}

function binaryFor(kind: RemoteEndpointKind): string | null {
  switch (kind) {
    case 'cloudflare_quick':
    case 'cloudflare_named':
      return 'cloudflared';
    case 'tailscale_funnel':
    case 'tailscale_serve':
      return 'tailscale';
    case 'custom':
      return null;
  }
}

/** Start command that produces the public address (may print `<TUNNEL_URL>`). */
function startRun(kind: RemoteEndpointKind, port: number): string | null {
  switch (kind) {
    case 'cloudflare_quick':
      return `cloudflared tunnel --url http://127.0.0.1:${port}`;
    case 'cloudflare_named':
      return `cloudflared tunnel login && cloudflared tunnel run --url http://127.0.0.1:${port} markus`;
    case 'tailscale_funnel':
      return `tailscale up && tailscale funnel ${port}`;
    case 'tailscale_serve':
      return `tailscale up && tailscale serve ${port}`;
    case 'custom':
      return null;
  }
}

/** Whether the address is registered with the Hub (tailscale_serve stays tailnet-only). */
function reachesHub(kind: RemoteEndpointKind): boolean {
  return kind !== 'tailscale_serve';
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────────

/** Build the frozen Path-B contract for a (kind, platform, port) choice. */
export function buildAgentTunnelTaskContract(input: AgentSetupPlanInput): AgentTunnelTaskContract {
  const port = input.localPort ?? DEFAULT_LOCAL_API_PORT;
  const api = `http://127.0.0.1:${port}`;
  const binary = binaryFor(input.kind);
  const commands: AgentTunnelTaskCommand[] = [];

  const install = installRun(input.kind, input.platform);
  if (install) {
    commands.push({
      shell: input.platform === 'windows' ? 'powershell' : 'sh',
      run: install,
      purpose: `安装 ${binary} 隧道客户端（${input.platform}）`,
      sensitive: true,
      idempotent: true,
    });
  }

  const start = startRun(input.kind, port);
  if (start) {
    commands.push({
      shell: input.platform === 'windows' ? 'powershell' : 'sh',
      run: start,
      purpose: reachesHub(input.kind)
        ? '启动隧道，指向本机 Markus API；记下输出里的公网地址'
        : '启动 Tailscale Serve（仅 tailnet 内可达，不注册到 Hub）',
      sensitive: false,
      idempotent: false,
    });
  }

  if (reachesHub(input.kind)) {
    commands.push({
      shell: 'sh',
      run:
        `curl -fsS -X POST ${api}/api/settings/remote/tunnel/register ` +
        `-H 'content-type: application/json' ` +
        `-d '{"kind":"${input.kind}","publicUrl":"<TUNNEL_URL>"}'`,
      purpose:
        '把上一步解析到的公网地址登记到本机 Markus（把 <TUNNEL_URL> 换成真实 https 地址），' +
        '由 Markus 负责向 Hub 注册与所有权校验',
      sensitive: true,
      idempotent: true,
    });
  }

  const criteria: AgentTunnelTaskSuccessCriterion[] = [];
  if (binary) {
    criteria.push({
      id: 'binary_present',
      description: `本机已安装 ${binary}`,
      check:
        input.platform === 'windows'
          ? `where ${binary} >NUL 2>&1`
          : `command -v ${binary} >/dev/null 2>&1`,
    });
  }
  criteria.push({
    id: 'tunnel_enabled',
    description: '本机 Markus 已接管隧道（enabled=true）',
    check: `curl -fsS ${api}/api/settings/remote | grep -q '"enabled":true'`,
  });
  criteria.push({
    id: 'address_registered',
    description: '公网地址已登记（publicUrl 为 https 地址）',
    check: `curl -fsS ${api}/api/settings/remote | grep -q '"publicUrl":"https://'`,
  });
  if (input.username && reachesHub(input.kind)) {
    const hub = (input.hubUrl ?? 'https://www.markus.global').replace(/\/+$/, '');
    criteria.push({
      id: 'hub_entry_ready',
      description: `Hub 入口已就绪（${input.username} 状态 ready）`,
      check: `curl -fsS ${hub}/api/remote/entry/${input.username} | grep -q '"status":"ready"'`,
    });
  }

  const rollback: AgentTunnelTaskRollbackStep[] = [];
  if (binary) {
    rollback.push({
      description: `停止 ${binary} 隧道进程`,
      run: binary === 'cloudflared' ? `pkill -f 'cloudflared tunnel' || true` : `tailscale funnel off || true`,
    });
  }
  rollback.push({
    description: '在本机 Markus 关闭远程访问（清除登记）',
    run: `curl -fsS -X POST ${api}/api/settings/remote/disable || true`,
  });
  if (binary) {
    rollback.push({
      description: `（可选）卸载 ${binary} 客户端`,
      run: null,
    });
  }

  return {
    goal:
      `在这台机器上开通 Markus 远程访问（${input.kind}），` +
      `让用户能通过 https://${input.username ?? '<用户名>'}.remote.markus.global 在手机上打开自己的 Markus，` +
      `且数据不经过 Markus 的服务器。`,
    commands,
    successCriteria: criteria,
    rollback,
  };
}

/**
 * The shareable entry URL for a Hub user: `https://{user}.remote.{hubApex}`.
 * `null` when the username is unknown (the prompt then only mentions the raw
 * tunnel address). `hubUrl` is normalised to its apex so `www.markus.global`
 * and `markus.global` both yield `…remote.markus.global`.
 */
export function buildEntryUrl(username: string | undefined, hubUrl?: string): string | null {
  if (!username) return null;
  let host = 'www.markus.global';
  try {
    host = new URL(hubUrl ?? '').hostname || host;
  } catch {
    /* keep the default host */
  }
  return `https://${username}.remote.${host.replace(/^www\./, '')}`;
}

/**
 * The exact prompt handed to the Agent's chat input. It is NOT auto-sent: the
 * settings wizard prefills it into the user's Team-Chat composer so the user
 * sees the task (and every command) before pressing send.
 *
 * Deterministic: same plan ⇒ same prompt. Embedding the contract as JSON (not
 * prose) is what lets the Agent execute without guessing.
 */
export function buildAgentSetupPrompt(
  contract: AgentTunnelTaskContract,
  opts: { entryUrl?: string | null } = {},
): string {
  const entry = opts.entryUrl ?? null;
  return [
    '请帮我完成「Markus 远程访问」的安装与配置。下面是已经定好的任务契约，请严格按它执行，不要自行发挥。',
    '',
    '执行规则：',
    '1. 逐条执行 commands；对 sensitive=true 的命令，先向我复述该命令并取得我的确认再执行。',
    '2. 每条命令执行后，运行对应的 successCriteria.check（退出码 0 = 达成），并把结果报告出来。',
    '3. 任何一步失败：立即停止，报告失败的命令、原始输出与你的判断；不要绕过、不要改用其他方案。',
    '4. 需要 <TUNNEL_URL> 时，用启动命令输出里解析到的 https 地址替换。',
    '5. 不要执行契约之外的操作（不改系统服务、不写密钥文件、不动其他配置）。',
    '6. 全部 successCriteria 达成后，报告每条 criterion 的结论；本机 Markus 会自动把状态切到 ready。',
    '7. 成功完成后，必须明确告诉我**可以用哪个（哪些）地址访问本机 Markus 服务**：',
    ...(entry ? [`   • 固定入口地址（长期使用推荐这个）：${entry}`] : []),
    '   • 隧道直接地址：执行过程中解析到的那个 https 公网地址。',
    '   并说明两者区别——入口地址固定不变；底层隧道地址在隧道重启后可能更换（Markus 会自动重新注册，入口地址不用改）。',
    '',
    '任务契约（JSON，权威）：',
    '```json',
    JSON.stringify(contract, null, 2),
    '```',
  ].join('\n');
}

/** Convenience: contract + prompt in one call. */
export function buildAgentSetupPlan(input: AgentSetupPlanInput): AgentSetupPlan {
  const contract = buildAgentTunnelTaskContract(input);
  const entryUrl = buildEntryUrl(input.username, input.hubUrl);
  return { contract, prompt: buildAgentSetupPrompt(contract, { entryUrl }) };
}
