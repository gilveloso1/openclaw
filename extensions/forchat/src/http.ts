import type { IncomingMessage, ServerResponse } from "node:http";
import type { FaqService, FaqStatus } from "./faq-store.js";
import type { ForChatConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseTenantKey(url: URL): string | null {
  return url.searchParams.get("tenant");
}

// ---------------------------------------------------------------------------
// Route handler factory
// ---------------------------------------------------------------------------

/**
 * Creates an HTTP handler for the ForChat admin API.
 *
 * Routes (all under /plugins/forchat/):
 *   GET  /plugins/forchat/faqs               → list approved FAQs
 *   GET  /plugins/forchat/faqs?status=all     → list all statuses
 *   POST /plugins/forchat/faqs               → create FAQ
 *   PUT  /plugins/forchat/faqs/:id           → update FAQ
 *   DELETE /plugins/forchat/faqs/:id         → delete FAQ
 *   GET  /plugins/forchat/suggestions        → list pending suggestions
 *   POST /plugins/forchat/suggestions/:id/approve → approve
 *   POST /plugins/forchat/suggestions/:id/reject  → reject
 *   GET  /plugins/forchat/flows              → list configured flows
 *   GET  /plugins/forchat/status             → plugin health
 */
export function createAdminHandler(
  faqService: FaqService,
  cfg: ForChatConfig,
  defaultTenantKey: string,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawUrl = req.url ?? "/";
    const base = "http://127.0.0.1";
    let url: URL;
    try {
      url = new URL(rawUrl, base);
    } catch {
      return false;
    }

    const pathname = url.pathname.replace(/\/+$/, "");
    const method = req.method?.toUpperCase() ?? "GET";
    const tenantKey = parseTenantKey(url) ?? defaultTenantKey;

    // ------------------------------------------------------------------
    // GET /plugins/forchat/status
    // ------------------------------------------------------------------
    if (pathname === "/plugins/forchat/status" && method === "GET") {
      const approved = await faqService.list(tenantKey, "approved");
      const suggested = await faqService.list(tenantKey, "suggested");
      sendJson(res, 200, {
        ok: true,
        faqCount: approved.length,
        pendingSuggestions: suggested.length,
        flows: Object.keys(cfg.flows),
        webhooks: cfg.delivery.webhooks.length,
      });
      return true;
    }

    // ------------------------------------------------------------------
    // GET /plugins/forchat/flows
    // ------------------------------------------------------------------
    if (pathname === "/plugins/forchat/flows" && method === "GET") {
      const flows = Object.entries(cfg.flows).map(([id, f]) => ({
        id,
        name: f.name,
        description: f.description,
        steps: f.steps.length,
      }));
      sendJson(res, 200, { flows });
      return true;
    }

    // ------------------------------------------------------------------
    // GET /plugins/forchat/suggestions
    // ------------------------------------------------------------------
    if (pathname === "/plugins/forchat/suggestions" && method === "GET") {
      const faqs = await faqService.list(tenantKey, "suggested");
      sendJson(res, 200, { faqs });
      return true;
    }

    // ------------------------------------------------------------------
    // POST /plugins/forchat/suggestions/:id/approve
    // POST /plugins/forchat/suggestions/:id/reject
    // ------------------------------------------------------------------
    const suggestionMatch = pathname.match(
      /^\/plugins\/forchat\/suggestions\/([^/]+)\/(approve|reject)$/,
    );
    if (suggestionMatch && method === "POST") {
      const [, id, action] = suggestionMatch;
      const status: FaqStatus = action === "approve" ? "approved" : "rejected";
      const updated = await faqService.updateFaq(id, { status });
      if (!updated) {
        sendError(res, 404, "FAQ not found");
        return true;
      }
      sendJson(res, 200, { ok: true, faq: updated });
      return true;
    }

    // ------------------------------------------------------------------
    // /plugins/forchat/faqs routes
    // ------------------------------------------------------------------
    if (pathname === "/plugins/forchat/faqs") {
      // GET — list
      if (method === "GET") {
        const statusParam = url.searchParams.get("status");
        const status = statusParam === "all" ? undefined : ((statusParam as FaqStatus) ?? "approved");
        const faqs = await faqService.list(tenantKey, status);
        sendJson(res, 200, { faqs });
        return true;
      }

      // POST — create
      if (method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return true;
        }
        if (!body || typeof body !== "object") {
          sendError(res, 400, "Body must be an object");
          return true;
        }
        const { question, answer } = body as Record<string, unknown>;
        if (typeof question !== "string" || typeof answer !== "string") {
          sendError(res, 400, "question and answer are required strings");
          return true;
        }
        const faq = await faqService.addFaq(tenantKey, question.trim(), answer.trim(), "approved");
        sendJson(res, 201, { faq });
        return true;
      }

      return false;
    }

    // ------------------------------------------------------------------
    // /plugins/forchat/faqs/:id routes
    // ------------------------------------------------------------------
    const faqMatch = pathname.match(/^\/plugins\/forchat\/faqs\/([^/]+)$/);
    if (faqMatch) {
      const [, id] = faqMatch;

      // GET — single FAQ
      if (method === "GET") {
        const faq = await faqService.get(id);
        if (!faq) { sendError(res, 404, "FAQ not found"); return true; }
        sendJson(res, 200, { faq });
        return true;
      }

      // PUT — update
      if (method === "PUT") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendError(res, 400, "Invalid JSON body");
          return true;
        }
        const patch = body as Record<string, unknown>;
        const updated = await faqService.updateFaq(id, {
          question: typeof patch.question === "string" ? patch.question.trim() : undefined,
          answer: typeof patch.answer === "string" ? patch.answer.trim() : undefined,
          status: typeof patch.status === "string" ? (patch.status as FaqStatus) : undefined,
        });
        if (!updated) { sendError(res, 404, "FAQ not found"); return true; }
        sendJson(res, 200, { faq: updated });
        return true;
      }

      // DELETE
      if (method === "DELETE") {
        const deleted = await faqService.deleteFaq(id);
        if (!deleted) { sendError(res, 404, "FAQ not found"); return true; }
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    return false;
  };
}
