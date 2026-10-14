/* eslint-disable no-console */
/**
 * U5 real-data probe — req_8f391 ("pick the group, don't paste an id").
 *
 * This is the **live** counterpart to the unit tests. The tests pin behaviour
 * against captured payloads; this probe drives the *real* platform APIs with the
 * *real* bot credentials already stored in the local Markus DB, so the owner can
 * see the three branches the notification picker must produce:
 *
 *   1. bot in a group  → channel list is non-empty  → the picker is offered
 *   2. bot in no group → channel list is empty      → the "add the bot …" hint
 *   3. platform cannot enumerate at all             → the manifest's guidance
 *
 * Nothing is mocked: a missing credential fails loudly, and a credential /
 * network failure surfaces as an error (never silently as an empty list).
 *
 * Run (from the repo root, via tsx so it reads the branch's *source*, not a
 * possibly-stale sibling `dist`):
 *
 *   npx tsx scripts/probe-u5-realdata.ts                # backend probe only
 *   npx tsx scripts/probe-u5-realdata.ts --e2e          # also send+read-back
 *   MARKUS_DB=/path/to/data.db npx tsx scripts/probe-u5-realdata.ts
 *
 * The E2E step sends **one** clearly-labelled message to the bot's configured
 * notification chat, reads it back through the API to prove delivery, then
 * recalls it. It is off unless `--e2e` is passed.
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { getManifest } from '../packages/comms/src/platforms/registry.ts';
import { FeishuClient } from '../packages/comms/src/feishu/client.ts';

const DB_PATH =
  process.env['MARKUS_DB'] ?? `${process.env['HOME']}/.markus/data.db`;
const WANT_E2E = process.argv.includes('--e2e');

/** One row of `platform_instances` (the real single source of bot config). */
interface InstanceRow {
  id: string;
  platform: string;
  label: string;
  config: Record<string, unknown>;
}

/** Read the real bot instances from the live DB — the same table the API reads. */
function readInstances(): InstanceRow[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const rows = db
    .prepare('SELECT id, platform, label, config FROM platform_instances')
    .all() as Array<{ id: string; platform: string; label: string; config: string }>;
  db.close();
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    label: r.label,
    config: JSON.parse(r.config) as Record<string, unknown>,
  }));
}

/** The verdict the `/channels` route derives — same facts, no second guess. */
function routeVerdict(row: InstanceRow): {
  supported: boolean;
  guidance: string | null;
} {
  const manifest = getManifest(row.platform);
  if (!manifest) throw new Error(`unknown platform: ${row.platform}`);
  return {
    supported: manifest.listChannels !== undefined,
    guidance: manifest.channelEnumerationGuidance ?? null,
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`   ${ok ? '✓' : '✗'} ${label} — ${detail}`);
}

/**
 * The real route responses, written out so the web-ui test can render the panel
 * from **real** backend data rather than a hand-written fixture. `channels` for
 * an enumerable platform are the live API result; the empty case is the route's
 * zero-item shape; the non-enumerable case carries the manifest's guidance key.
 */
const capture: {
  generatedAt?: string;
  feishu?: { supported: boolean; channels: Array<{ id: string; name: string; kind: string }> };
  empty?: { supported: boolean; channels: unknown[] };
  telegram?: { supported: boolean; channels: unknown[]; guidance: string | null };
} = {};

/** Mask anything that looks like a secret so the probe is safe to paste. */
function mask(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  return value.length <= 6 ? '***' : `${value.slice(0, 4)}…(${value.length})`;
}

/**
 * Backend probe — call the real `listChannels` for every live instance and
 * check the verdict against what the platform is *supposed* to be able to do.
 */
async function probeBackend(instances: InstanceRow[]): Promise<void> {
  console.log('\n=== 1. backend enumeration (live) ===');
  for (const row of instances) {
    const manifest = getManifest(row.platform);
    if (!manifest) {
      console.log(`\n[${row.platform}] ${row.id}: UNKNOWN platform`);
      failures += 1;
      continue;
    }
    const verdict = routeVerdict(row);
    console.log(
      `\n[${row.platform}] ${row.id} (label=${row.label}) — canListChannels=${verdict.supported}`,
    );

    if (!verdict.supported) {
      // Branch 3: cannot enumerate → guidance must be present (never silent).
      check(
        'non-enumerable platform carries guidance',
        verdict.guidance !== null,
        `guidance=${verdict.guidance ?? '∅'}`,
      );
      if (row.platform === 'telegram') {
        capture.telegram = { supported: false, channels: [], guidance: verdict.guidance };
      }
      continue;
    }

    if (row.platform !== 'feishu') {
      console.log(`   (live call skipped — no probe driver for ${row.platform})`);
      continue;
    }

    // Branch 1 / 2: the live call decides. We print the real channels, and
    // assert the *contract* (an array of {id,name}) rather than a count, since
    // whether the bot is in a group is exactly what we are measuring.
    try {
      const channels = await manifest.listChannels(row.config);
      const wellFormed = channels.every(
        (c) => typeof c.id === 'string' && c.id.length > 0 && typeof c.name === 'string',
      );
      check('live listChannels returns well-formed PlatformChannel[]', wellFormed, `${channels.length} channel(s)`);
      if (row.platform === 'feishu') {
        capture.feishu = { supported: true, channels };
      }
      if (channels.length > 0) {
        console.log('   → branch 1 (bot IS in a group): the picker is offered. Those groups:');
        for (const c of channels.slice(0, 20)) console.log(`       • ${c.name}  [${c.id}]`);
        const dest = typeof row.config['notifyChatId'] === 'string' ? row.config['notifyChatId'] : '';
        if (dest) {
          const offered = channels.some((c) => c.id === dest);
          check(
            'the configured destination is one of the offered groups',
            offered,
            offered ? `notifyChatId=${dest} is in the list` : `notifyChatId=${dest} NOT in list`,
          );
        }
      } else {
        console.log('   → branch 2 (bot is NOT in any group): the list is empty.');
      }
      console.log(`   (appId=${mask(row.config['appId'])}, appSecret=${mask(row.config['appSecret'])})`);
    } catch (e) {
      check('live listChannels did not throw', false, `${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * End-to-end probe (opt-in, `--e2e`): send a real notification to the bot's
 * **configured** destination through the real outbound client, read it back via
 * the API to prove it truly landed, then recall it. This is the "select a group
 * → the notification really arrives" path, minus the UI click.
 */
async function probeE2E(instances: InstanceRow[]): Promise<void> {
  console.log('\n=== 3. end-to-end delivery (Feishu, live) ===');
  const feishu = instances.find((r) => r.platform === 'feishu');
  if (!feishu) {
    console.log('   no feishu instance — skipped');
    return;
  }
  const chatId = typeof feishu.config['notifyChatId'] === 'string' ? feishu.config['notifyChatId'] : '';
  if (!chatId) {
    console.log('   feishu instance has no notifyChatId (no destination) — skipped');
    return;
  }
  const appId = String(feishu.config['appId'] ?? '');
  const appSecret = String(feishu.config['appSecret'] ?? '');
  const domain = typeof feishu.config['domain'] === 'string' ? feishu.config['domain'] : undefined;
  const client = new FeishuClient({ appId, appSecret, ...(domain ? { domain } : {}) });

  const marker = `U5-e2e-${Date.now().toString(36)}`;
  const text = `[Markus U5 验证] 通知送达探针 ${marker} — 若你看到这条消息，说明「选群 → 通知真送达」链路通。此消息会被自动撤回。`;

  console.log(`   destination chat: ${chatId}`);
  console.log(`   sending marker: ${marker}`);
  let messageId = '';
  try {
    messageId = await client.sendTextMessage(chatId, text);
    check('message sent through the real outbound client', messageId.length > 0, `message_id=${messageId || '∅'}`);
  } catch (e) {
    check('message sent through the real outbound client', false, `${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // Read back: the only proof of delivery is that the API now reports our
  // message as existing **inside that chat**. We read it by id — the chat-wide
  // list endpoint needs the `im:message.group_msg` scope, which this bot lacks;
  // the per-message endpoint does not, and returns the message's chat + sender.
  try {
    const token = await client.getTenantToken();
    const res = await fetch(`${domain ?? 'https://open.feishu.cn'}/open-apis/im/v1/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      code: number;
      data?: { items?: Array<Record<string, unknown>> };
    };
    const item = body.data?.items?.[0] ?? {};
    const chat = item['chat_id'] ?? item['chat_id'];
    const sender = (item['sender'] as Record<string, unknown> | undefined)?.['id'];
    check(
      'message readable back by id (proves it landed in the chat)',
      body.code === 0 && item['message_id'] === messageId && chat === chatId,
      `code=${body.code} chat=${String(chat)} sender=${String(sender)} deleted=${String(item['deleted'])}`,
    );
  } catch (e) {
    check('message readable back by id', false, `${e instanceof Error ? e.message : String(e)}`);
  }

  // Recall — leave no residue in the owner's group. A successful delete is a
  // second, independent confirmation that the message really existed.
  try {
    await client.deleteMessage(messageId);
    console.log(`   ✓ recalled the test message (${messageId})`);
  } catch (e) {
    console.log(`   ⚠ could not recall ${messageId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log(`U5 real-data probe — db=${DB_PATH}`);
  const instances = readInstances();
  console.log(
    `live instances: ${instances.map((r) => `${r.platform}:${r.id}`).join(', ') || '(none)'}`,
  );
  await probeBackend(instances);
  // The route's zero-item shape, for the front-end empty-state probe.
  capture.empty = { supported: true, channels: [] };
  capture.generatedAt = new Date().toISOString();
  if (WANT_E2E) await probeE2E(instances);
  else console.log('\n(E2E skipped — pass --e2e to send + read back a real message)');

  const out = process.env['U5_CAPTURE_OUT'] ?? '/tmp/u5-capture.json';
  writeFileSync(out, JSON.stringify(capture, null, 2));
  console.log(`\ncapture written → ${out}`);

  console.log(`\n--- ${failures === 0 ? 'PASS' : `FAIL (${failures} check(s))`} ---`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
