# Configuration & File Locations

Status: **implemented** (2026-10-11) · Owner-directed: *no fallbacks, no
duplication; keep reading legacy keys; write to the correct location.*

Markus configuration has accreted three overlapping stores with **non-uniform
precedence** and several **double-written facts**. This document defines the
target model and the compatibility path. It is the single reference for "where
does this value live?".

## 1. Files & locations (single source of truth)

All clients — developer checkout, `npm i -g` CLI, and the packaged desktop app —
use the **same** layout. Paths are resolved in exactly one place:
`packages/shared/src/utils/config-paths.ts`.

```
~/.markus/                     ← MARKUS_HOME (env override; default ~/.markus)
  ├─ markus.json               bootstrap + static ops config   (config.ts)
  ├─ .env                      secrets + machine/CI overrides  (env.ts)
  ├─ data.db                   SQLite: runtime / UI state
  ├─ jwt-secret               0600
  ├─ gateway-secret           0600
  ├─ initial-admin-password   0600
  └─ logs/ agents/ teams/ skills/ cache/ …
```

**Nothing durable is written inside the application bundle / install directory**
— an installer upgrade replaces that directory wholesale. The bundle ships
read-only templates only.

| Platform | Installed application | Durable config/state |
|---|---|---|
| macOS | `/Applications/Markus.app` (DMG → /Applications) | `~/.markus/` |
| Windows | `%LOCALAPPDATA%\Programs\Markus` (NSIS, per-user) | `~/.markus/` |
| Linux | AppImage (portable, no install step) | `~/.markus/` |

> The working directory of a packaged app is **not** meaningful. Anything that
> resolves config from `process.cwd()` is a bug for installed clients.

## 2. The three planes and what each one owns

| Plane | Owns | Who writes |
|---|---|---|
| **`~/.markus/.env`** | **Secrets** (`JWT_SECRET`, `ADMIN_PASSWORD`, `GATEWAY_SECRET`, `*_API_KEY`) and machine/CI/deploy overrides (`DATABASE_URL`, proxy, `AUTH_ENABLED`) | the operator (hand / deployment) |
| **SQLite** | **UI/API-mutable runtime state**: org settings, per-agent `llm_config`/`profile`, platform instances & channel bindings, search-provider toggles | the Settings/API layer (one writer) |
| **`markus.json`** | **Bootstrap seed + static ops config**: ports, browser mode, coding tools, MCP servers, network proxy, file storage — never secrets | `saveConfig` (bootstrap / CLI) |

Rule of thumb:

> **Secrets → `.env`. Things the user edits in the UI → DB. Things an operator
> sets before first run → `markus.json`.**

## 3. Precedence (uniform, documented, no hidden layering)

Each fact has **one canonical home**. Resolution order is global and explicit:

1. a value already present in the **environment** (shell / container / CI)
2. the canonical **`.env`** file (`~/.markus/.env`)
3. the **legacy** location, read **only to fill a gap** (compat)

"Legacy read" is a bounded compatibility adapter, not a second source of truth:
it lets an old config keep working, and it disappears naturally once the value is
written to the canonical location. Writes **never** target a legacy location.

## 4. Compatibility contract (old clients / old configs)

Existing installs must keep working with **zero action from the user**:

- **Old key names / old locations are still read.** A value found in a legacy
  key or file is honoured. It is never dropped, and never silently rewritten.
- **Writes go to the canonical location only.** The next time the value is
  saved, it lands in the canonical home — so configs self-migrate over time.
- **No destructive migration.** Legacy keys are left in place (harmless); they
  simply stop being read once the canonical value exists.
- **`MARKUS_HOME`** overrides the whole tree (tests, portable/service installs).

## 5. Defects found → target fix

| # | Defect (evidence) | Class | Target |
|---|---|---|---|
| D1 | `.env` loaded from `process.cwd()` only, in the CLI entry — the packaged desktop app never loads `.env` at all | wrong location / missing | read `~/.markus/.env` canonically, in `loadEnvFile()` called by **both** CLI entry and `startBackend` |
| D2 | `org.name` written to **both** `markus.json` and the DB | R1 double-writer | DB is canonical; `markus.json` value is a legacy-read seed |
| D3 | provider `apiKey`: **file > env**, while security secrets are **env > file** | inconsistent precedence | secrets uniformly env-first; legacy file read as fallback |
| D4 | `adminPassword` / `gatewaySecret` settable in file **and** env | duplication | one canonical (env), legacy file read |
| D5 | config paths computed in 20+ places via `join(homedir(), '.markus', …)` | no single source | all go through `config-paths.ts` |

## 6. Rollout

1. **Paths + env loader** (`config-paths.ts`, `env.ts`) — *done*.
2. Wire every entry point through `loadEnvFile()` — *done* (CLI entry, `startBackend`).
3. Fix D2/D3/D4 with legacy-read adapters + tests — *in progress*.
4. Sweep remaining direct path literals (D5) onto `config-paths.ts`.
5. Docs: `guide.md` / `remote-access.md` / `architecture.md` point here as the
   single reference; `markus.json.example` / `.env.example` stay as templates.

## 7. Industry practice (why this shape)

The shape above is not invented — it mirrors how comparable agent platforms do
it (verified against their docs, 2026-10-11):

| | Home dir | **Secrets** | Non-secret config |
|---|---|---|---|
| **Hermes** (Nous) | `~/.hermes/` | `.env` | `config.yaml` |
| **OpenClaw** | `~/.openclaw/` | `.env` (recommended for provider keys) | `openclaw.json` |
| **DeepSeek Harness** | `~/.dsh/` | `.credentials.yaml` (0600) | `settings.yaml` |

Common rules we adopt:

1. **One home dir under the user's home** (`~/.<app>/`). Never inside the
   install dir.
2. **Secrets live in one dedicated secrets file**, separate from settings.
3. **Uniform precedence**: process env → `~/.<app>/.env` → (legacy) config file;
   **never override an existing value**.
4. **Config references secrets by name** (`apiKeyEnv` / OpenClaw SecretRef) — the
   config file may be shared/committed; the secret only lives in the store.
5. **A workspace (cwd) `.env` is low-trust**: OpenClaw ignores provider
   credentials from it; so do we (`isSecretEnvKey`).
6. **Legacy locations are read as a compat fallback** and warn on conflict
   (OpenClaw reads the old `~/.config/openclaw/gateway.env`).

## 8. Implemented (2026-10-11)

- `packages/shared/src/utils/config-paths.ts` — the single path source
  (`markusHome` / `markusConfigPath` / `markusEnvPath` / `markusDbPath`).
- `packages/shared/src/utils/env.ts` — the single env/secret store reader **and
  writer** (`loadEnvFile` / `setEnvValue` / `unsetEnvValue`), with cwd demotion.
- `packages/shared/src/utils/secrets.ts` — `isSecretEnvKey`, platform-secret
  resolution (env → persisted random).
- Provider keys: resolved env-first with `apiKeyEnv` indirection; **writes go to
  `~/.markus/.env`**, markus.json keeps only `apiKeyEnv` (legacy `apiKey` is
  read-only and self-heals on the next edit).
- **Markus Cloud (OpenRouter) member key** follows the same rule: canonical store
  var `MARKUS_OPENROUTER_KEY`; config keeps `apiKeyEnv` only. Every writer
  (`ensureMarkusDirectConfig`, `syncOpenRouterCredentialsFromHub`, the
  Hub-connect / subscription-key settings flow, CLI start) writes to `.env` and
  strips any legacy plaintext `markus.apiKey` on disk.
- Search / coding-tool keys: written to `~/.markus/.env`; legacy plaintext
  config fields are stripped on save.
- **One implementation of the provider-key write**:
  `packages/shared/src/utils/provider-secrets.ts` (`providerEnvKey` /
  `persistProviderSecret`). Every CLI writer — `init` (env / manual / platform
  import), `model` (interactive + non-interactive) and `auth add` — and the API
  server's `persistProviderSecret` delegate to it. Detected-in-environment keys
  are **used, never persisted** to markus.json — they land in `~/.markus/.env`
  with an `apiKeyEnv` reference.
- `deepMerge` now honours a source `null` as a delete **even under a brand-new
  parent object** (previously `key: null` was copied verbatim on first write, so
  a fresh provider kept a literal `"apiKey": null`). This is what makes
  "drop plaintext on edit" actually remove the key from `markus.json`.
- The seeded default **Secretary name is localized** to the owner/host locale
  (`packages/shared/src/locale.ts` + `SECRETARY_DISPLAY_NAMES`); identification
  stays locale-independent (the `secretary` role template is the stable key).
- `org.name`: **DB is the single writer**; markus.json is a one-time seed.
- Entry points: `loadEnvFile()` runs in both the CLI entry and `startBackend`
  (so the packaged desktop app reads `~/.markus/.env`, which it never did before).
