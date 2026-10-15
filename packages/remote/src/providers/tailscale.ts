/**
 * Tailscale tunnel providers (T6).
 *
 * Unlike cloudflared these are `service`-managed: the command hands the config
 * to `tailscaled` and returns, so the public URL is read from a `status` query
 * rather than a long-lived child's logs. `stop` is therefore an explicit `off`
 * command, not a process signal.
 *
 *  • `tailscale_funnel` — public `https://<host>.<tailnet>.ts.net`.
 *  • `tailscale_serve`  — tailnet-internal only. It deliberately never reaches
 *    the Hub registry (kind exists for guidance); the manager still runs it so
 *    the UI can report a stable private URL.
 */

import { parseTailscalePublicUrl } from '../url-parse.js';
import { installCommand, type TunnelCommand, type TunnelProvider } from './types.js';

/** `tailscale funnel status` / `tailscale serve status` print the URL plainly. */
const statusUrl = (stdout: string): string | null => parseTailscalePublicUrl(stdout);

export const tailscaleFunnelProvider: TunnelProvider = {
  management: 'service',
  binary: 'tailscale',
  kind: 'tailscale_funnel',
  urlFromConfig: false,

  // `--bg` returns immediately after registering the funnel with tailscaled.
  startCommand: (ctx): TunnelCommand => ({
    bin: 'tailscale',
    args: ['funnel', '--bg', String(ctx.apiPort)],
  }),
  statusCommand: (): TunnelCommand => ({ bin: 'tailscale', args: ['funnel', 'status'] }),
  stopCommand: (): TunnelCommand => ({ bin: 'tailscale', args: ['funnel', 'off'] }),

  // The live `funnel` command also echoes the URL; accept both paths.
  parseUrl: parseTailscalePublicUrl,
  parseStatus: statusUrl,

  installCommands: (platform) => tailscaleInstall(platform),
};

export const tailscaleServeProvider: TunnelProvider = {
  management: 'service',
  binary: 'tailscale',
  kind: 'tailscale_serve',
  urlFromConfig: false,

  startCommand: (ctx): TunnelCommand => ({
    bin: 'tailscale',
    args: ['serve', '--bg', String(ctx.apiPort)],
  }),
  statusCommand: (): TunnelCommand => ({ bin: 'tailscale', args: ['serve', 'status'] }),
  stopCommand: (): TunnelCommand => ({ bin: 'tailscale', args: ['serve', 'off'] }),

  parseUrl: parseTailscalePublicUrl,
  parseStatus: statusUrl,

  installCommands: (platform) => tailscaleInstall(platform),
};

function tailscaleInstall(platform: NodeJS.Platform) {
  switch (platform) {
    case 'darwin':
      return [
        installCommand('brew install tailscale', '通过 Homebrew 安装 Tailscale（macOS）'),
        installCommand(
          'tailscale funnel --help',
          '确认 tailscale CLI 可用且支持 funnel（需在管理台开启 HTTPS 证书）',
          { idempotent: true },
        ),
      ];
    case 'win32':
      return [
        installCommand(
          'winget install --id Tailscale.Tailscale -e',
          '通过 winget 安装 Tailscale（Windows）',
        ),
      ];
    default:
      return [
        installCommand('curl -fsSL https://tailscale.com/install.sh | sh', '安装 Tailscale（Linux）'),
      ];
  }
}
