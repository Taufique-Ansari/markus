/**
 * Front-end extras registry — the *opt-in* richer panel a platform can add.
 *
 * The manifest is pure data serialised over HTTP, so it cannot carry a React
 * render function. The extras slot therefore lives here, keyed by platform id:
 * a platform with an entry gets its extra panel, a platform without one gets
 * the plain generic card and nothing else.
 */
import type { PlatformExtras } from '../../lib/platformIntegrations.ts';
import { FeishuExtras, FeishuTestMessage } from './FeishuExtras.tsx';

export const PLATFORM_EXTRAS: Record<string, PlatformExtras> = {
  feishu: {
    // This panel is only what a plain manifest form cannot express: the
    // scan-to-create QR. The notification destination and its preference knobs
    // are rendered by the generic `NotificationPanel`, for every platform, from
    // the manifest annotation — so this entry deliberately owns no field.
    placement: 'before',
    // Feishu can create + configure its own app from a QR scan, so hand-typing
    // an app id + secret is the *fallback*, not a second step. The card turns
    // these into a either/or chooser (see `guidedSetup`): the scan panel and the
    // credential inputs are never on screen together.
    guidedSetup: { credentialFields: ['appId', 'appSecret'] },
    render: (ctx) => <FeishuExtras ctx={ctx} />,
    // Feishu is currently the one platform whose backend exposes a real
    // test-send endpoint. The generic panel renders this control where a
    // platform opts in; it is data here, never a branch inside the panel.
    sendTest: (ctx) => <FeishuTestMessage ctx={ctx} />,
  },
};
