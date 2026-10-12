/**
 * Secretary identification — the single source of truth for "which agent is the
 * org-level Secretary".
 *
 * ── Why this lives in `@markus/shared` ──────────────────────────────────────
 *
 * Two very different callers need the *same* rule:
 *
 *   • `OrgService` (org-manager) resolves the org Secretary from **live agent
 *     objects** (`AgentManager.listAgents()`), e.g. the workflow reviewer
 *     fallback and `isProtectedAgent`.
 *   • The messaging-gateway data migration (storage) resolves it from **raw
 *     `agents` table rows** to seed the default notification binding.
 *
 * Keeping one implementation here is what stops those two from drifting apart
 * (the "same fact, two writers" smell). Both packages already depend on
 * `@markus/shared`, so the shared home is free.
 *
 * The rule itself is deliberately narrow — it recognises the org Secretary and
 * *not* teams that happen to reuse the Secretary role template (e.g. a research
 * lab's 「协调秘书」): an agent with `agentRole === 'secretary'`, the exact name
 * `Secretary` / `秘书`, or a role name starting with `secretary`.
 */

import { normalizeLanguage } from './locale.js';

/**
 * Localized display name for the default (org-level) Secretary agent, keyed by
 * bare language subtag. The seeded agent inherits the name matching the host /
 * owner locale so first-run users don't meet an English label in a non-English
 * environment. Identification never depends on the name alone — `agentRole`
 * and the role template keep working regardless.
 */
export const SECRETARY_DISPLAY_NAMES: Record<string, string> = {
  en: 'Secretary',
  zh: '秘书',
  ja: '秘書',
  ko: '비서',
  es: 'Secretario',
  pt: 'Secretário',
  fr: 'Secrétaire',
  de: 'Sekretär',
  it: 'Segretario',
  ru: 'Секретарь',
  id: 'Sekretaris',
  vi: 'Thư ký',
  th: 'เลขานุการ',
  tr: 'Sekreter',
  ar: 'سكرتير',
  hi: 'सचिव',
};

/** Every known Secretary display name — locales we have a label for. */
const SECRETARY_NAMES = new Set(Object.values(SECRETARY_DISPLAY_NAMES));

/** The Secretary name for a locale (falls back to English). */
export function secretaryDisplayName(locale?: string): string {
  return SECRETARY_DISPLAY_NAMES[normalizeLanguage(locale)] ?? SECRETARY_DISPLAY_NAMES['en']!;
}

/** The tag subset every Secretary predicate looks at. */
export interface SecretaryLikeFields {
  name?: string;
  /** Role template name (live agent `role`, DB `role_name`). */
  role?: string;
  agentRole?: string;
}

/** Candidate shape for {@link pickOrgSecretary} — needs an id and optional team. */
export interface SecretaryCandidate extends SecretaryLikeFields {
  id: string;
  /** Set when the agent belongs to a team (as opposed to the org at large). */
  teamId?: string | null;
}

/** True when an agent's identity marks it as a Secretary-class agent. */
export function isSecretaryLikeAgent(a: SecretaryLikeFields): boolean {
  const role = (a.role ?? '').toLowerCase().trim();
  const name = (a.name ?? '').trim();
  if (a.agentRole === 'secretary') return true;
  if (SECRETARY_NAMES.has(name)) return true;
  // "secretary", "Secretary 角色定义", etc.
  if (role === 'secretary' || role.startsWith('secretary')) return true;
  return false;
}

/**
 * Pick the org-level Secretary from a list of agents.
 *
 * Preference order (unchanged from the original `OrgService.findOrgSecretary`):
 * an agent with **no team** wins, then an exact `Secretary` / `秘书` name, then
 * the first Secretary-like agent. Returns `undefined` when none qualify.
 */
export function pickOrgSecretary<T extends SecretaryCandidate>(agents: readonly T[]): T | undefined {
  const secretaries = agents.filter((a) => isSecretaryLikeAgent(a));
  if (secretaries.length === 0) return undefined;
  return (
    secretaries.find((a) => !a.teamId)
    ?? secretaries.find((a) => SECRETARY_NAMES.has((a.name ?? '').trim()))
    ?? secretaries[0]
  );
}
