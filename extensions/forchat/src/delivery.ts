import { createHmac } from "node:crypto";
import type { WebhookTarget } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeliveryPayload = {
  flow: string;
  sessionKey: string;
  tenantKey: string;
  timestamp: number;
  data: Record<string, string>;
};

export type DeliveryResult = {
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Signs the payload body with HMAC-SHA256 using the webhook secret. */
function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Delivers payload to all configured webhooks. Returns one result per target. */
export async function deliverToWebhooks(
  webhooks: WebhookTarget[],
  payload: DeliveryPayload,
): Promise<DeliveryResult[]> {
  if (webhooks.length === 0) return [];

  const body = JSON.stringify(payload);

  return Promise.all(
    webhooks.map(async (webhook): Promise<DeliveryResult> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-ForChat-Flow": payload.flow,
        "X-ForChat-Timestamp": String(payload.timestamp),
        ...webhook.headers,
      };

      if (webhook.secret) {
        headers["X-ForChat-Signature"] = `sha256=${signPayload(body, webhook.secret)}`;
      }

      try {
        const res = await fetch(webhook.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        return { url: webhook.url, ok: res.ok, status: res.status };
      } catch (err) {
        return {
          url: webhook.url,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
