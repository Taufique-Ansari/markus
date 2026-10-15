/**
 * Cloudflare tunnel providers (T6).
 *
 *  • `cloudflare_quick` — `cloudflared tunnel --url http://127.0.0.1:PORT`:
 *    zero-config, gives a random `*.trycloudflare.com` host that CHANGES on
 *    every restart (hence the rotation path in the manager).
 *  • `cloudflare_named` — a named tunnel bound to the user's own domain; the
 *    address is stable and therefore comes from config, not from logs.
 */

import { hostnameToOrigin, parseCloudflaredPublicUrl } from '../url-parse.js';
import { installCommand, type TunnelProvider } from './types.js';

/** Cloudflare's default ingress target for a named tunnel (see docs/guides). */
const DEFAULT_CONFIG_FILE = '~/.cloudflared/config.yml';

export const cloudflareProvider: TunnelProvider = {
  management: 'process',
  binary: 'cloudflared',

  // cloudflare_quick
  kind: 'cloudflare_quick',
  urlFromConfig: false,

  startCommand: (ctx) => ({
    bin: 'cloudflared',
    // --no-autoupdate keeps the child stable (an in-place upgrade would exit).
    args: ['tunnel', '--no-autoupdate', '--url', `http://${ctx.bindHost}:${ctx.apiPort}`],
  }),

  // `cloudflared` writes the trycloudflare URL to stderr inside a banner box.
  parseUrl: parseCloudflaredPublicUrl,

  installCommands: (platform) => cloudflaredInstall(platform),
};

/** Named tunnel: `cloudflared tunnel --config <file> run <name>`; URL from config. */
export const cloudflareNamedProvider: TunnelProvider = {
  management: 'process',
  binary: 'cloudflared',
  kind: 'cloudflare_named',
  urlFromConfig: true,

  startCommand: (ctx) => ({
    bin: 'cloudflared',
    args: [
      'tunnel',
      '--no-autoupdate',
      '--config',
      ctx.configFile ?? DEFAULT_CONFIG_FILE,
      'run',
      ctx.tunnelName ?? 'markus',
    ],
  }),

  // Named tunnels do not print a public URL — it is the routed hostname.
  parseUrl: () => null,
  urlFromContext: (ctx) => hostnameToOrigin(ctx.hostname),

  installCommands: (platform) => cloudflaredInstall(platform),
};

function cloudflaredInstall(platform: NodeJS.Platform) {
  switch (platform) {
    case 'darwin':
      return [
        installCommand('brew install cloudflared', '通过 Homebrew 安装 cloudflared 隧道客户端（macOS）'),
      ];
    case 'win32':
      return [
        installCommand(
          'winget install --id Cloudflare.cloudflared -e',
          '通过 winget 安装 cloudflared 隧道客户端（Windows）',
        ),
      ];
    default:
      return [
        installCommand(
          'mkdir -p ~/.local/bin && curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared',
          '下载 cloudflared 并安装到 ~/.local/bin（Linux，无需 sudo）',
        ),
      ];
  }
}
