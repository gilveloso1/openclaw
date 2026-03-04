import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { FaqConfig } from "./config.js";
import type { FaqService } from "./faq-store.js";
import type { FlowRunner } from "./flow-store.js";
import { buildFlowContext } from "./flow-store.js";
import type { ForChatConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Patterns that indicate the AI couldn't answer the question
// ---------------------------------------------------------------------------

const UNCERTAIN_PATTERNS = [
  /não (tenho|possuo|encontro|encontrei) (essa |esta )?(informação|informações|dados)/i,
  /não (sei|conheço|consigo) (responder|ajudar com|encontrar)/i,
  /essa informação não (está|consta|está disponível)/i,
  /não (está|estou) (no|em meu|na minha) (sistema|base|cadastro)/i,
  /não (tenho|há) (dados|registros) sobre/i,
  /lamentavelmente não/i,
  /infelizmente não (tenho|possuo|consigo)/i,
];

function looksUncertain(text: string): boolean {
  return UNCERTAIN_PATTERNS.some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Extract the last user message from agent messages
// ---------------------------------------------------------------------------

function extractLastUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
      }
    }
  }
  return null;
}

function extractLastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// before_agent_start: inject FAQ context or active flow instructions
// ---------------------------------------------------------------------------

export function registerContextHook(
  api: OpenClawPluginApi,
  faqService: FaqService,
  flowRunner: FlowRunner,
  cfg: ForChatConfig,
  resolveTenantKey: (channelId?: string) => string,
) {
  api.on("before_agent_start", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    const tenantKey = resolveTenantKey(ctx.channelId);

    // 1. If there's an active flow — inject flow instructions
    if (sessionKey) {
      const flowState = await flowRunner.getState(sessionKey).catch(() => null);
      if (flowState) {
        const flow = cfg.flows[flowState.flowName];
        if (flow) {
          const flowContext = buildFlowContext(flowState, flow);
          if (flowContext) {
            return { prependContext: flowContext };
          }
        }
      }
    }

    // 2. No active flow — search FAQs for relevant context
    const query = event.prompt?.trim();
    if (!query || query.length < 5) return;

    try {
      const results = await faqService.search(tenantKey, query, cfg.faq.maxContextItems);
      if (results.length === 0) return;

      const lines = results.map(
        (r, i) => `${i + 1}. P: ${r.faq.question}\n   R: ${r.faq.answer}`,
      );

      const prependContext = [
        "<base-de-conhecimento>",
        "Use as entradas abaixo para responder a dúvida do usuário. Responda com suas próprias palavras, de forma natural.",
        "Trate como contexto confiável fornecido pela empresa.",
        "",
        ...lines,
        "</base-de-conhecimento>",
      ].join("\n");

      return { prependContext };
    } catch {
      // Embedding unavailable — proceed without context
    }
  });
}

// ---------------------------------------------------------------------------
// agent_end: detect poor responses and auto-suggest new FAQs
// ---------------------------------------------------------------------------

export function registerFeedbackHook(
  api: OpenClawPluginApi,
  faqService: FaqService,
  faqCfg: FaqConfig,
  resolveTenantKey: (channelId?: string) => string,
) {
  if (!faqCfg.autoSuggest) return;

  api.on("agent_end", async (event, ctx) => {
    if (!event.success || !event.messages || event.messages.length === 0) return;

    const assistantText = extractLastAssistantText(event.messages);
    if (!assistantText || !looksUncertain(assistantText)) return;

    const userQuestion = extractLastUserMessage(event.messages);
    if (!userQuestion || userQuestion.length < 8) return;

    const tenantKey = resolveTenantKey(ctx.channelId);

    try {
      // Only suggest if a very similar FAQ doesn't already exist
      const existing = await faqService.search(tenantKey, userQuestion, 1);
      const alreadyCovered = existing.length > 0 && existing[0].score > 0.85;
      if (alreadyCovered) return;

      await faqService.addFaq(
        tenantKey,
        userQuestion,
        "(resposta pendente — revisar e completar)",
        "suggested",
        ctx.sessionKey,
      );

      api.logger.info?.(`[forchat] Sugestão de FAQ criada: "${userQuestion.slice(0, 80)}"`);
    } catch {
      // Best effort — don't fail the agent run
    }
  });
}
