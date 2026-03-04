import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ForChatConfig } from "./config.js";
import type { FaqService } from "./faq-store.js";
import type { FlowRunner } from "./flow-store.js";
import type { DeliveryPayload } from "./delivery.js";
import { deliverToWebhooks } from "./delivery.js";

// ---------------------------------------------------------------------------
// Tool: faq_search
// ---------------------------------------------------------------------------

export function createFaqSearchTool(
  faqService: FaqService,
  resolveTenantKey: () => string,
) {
  return {
    name: "faq_search",
    label: "Busca na base de conhecimento",
    description:
      "Busca perguntas e respostas na base de conhecimento da empresa. " +
      "Use antes de responder qualquer dúvida sobre produtos, serviços, horários, preços ou políticas. " +
      "Retorna as entradas mais relevantes com score de similaridade.",
    parameters: Type.Object({
      query: Type.String({ description: "Pergunta ou tema a buscar" }),
      limit: Type.Optional(
        Type.Number({ description: "Número máximo de resultados (padrão: 5)", minimum: 1, maximum: 10 }),
      ),
    }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      const tenantKey = resolveTenantKey();
      const results = await faqService.search(tenantKey, params.query, params.limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Nenhuma resposta encontrada na base de conhecimento para essa pergunta." }],
          details: { count: 0 },
        };
      }

      const lines = results.map(
        (r, i) =>
          `${i + 1}. [P] ${r.faq.question}\n   [R] ${r.faq.answer}`,
      );

      return {
        content: [{ type: "text" as const, text: `Encontrados ${results.length} resultado(s):\n\n${lines.join("\n\n")}` }],
        details: { count: results.length, results: results.map((r) => ({ id: r.faq.id, question: r.faq.question, answer: r.faq.answer, score: r.score })) },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: capture_start
// ---------------------------------------------------------------------------

export function createCaptureStartTool(
  runner: FlowRunner,
  cfg: ForChatConfig,
  resolveTenantKey: () => string,
) {
  const flowNames = Object.keys(cfg.flows);

  return {
    name: "capture_start",
    label: "Iniciar fluxo de captura",
    description:
      "Inicia um fluxo guiado para coletar informações do usuário (ex: pedido, orçamento, agendamento). " +
      "Use quando o usuário demonstrar intenção de fazer um pedido, solicitar um orçamento ou agendar algo. " +
      `Fluxos disponíveis: ${flowNames.join(", ") || "(nenhum configurado)"}.`,
    parameters: Type.Object({
      flowName: Type.String({ description: `Nome do fluxo. Opções: ${flowNames.join(", ")}` }),
      sessionKey: Type.String({ description: "Chave da sessão atual (ctx.sessionKey)" }),
    }),
    async execute(_toolCallId: string, params: { flowName: string; sessionKey: string }) {
      const flow = cfg.flows[params.flowName];
      if (!flow) {
        return {
          content: [{ type: "text" as const, text: `Fluxo '${params.flowName}' não encontrado. Disponíveis: ${flowNames.join(", ")}` }],
          details: { error: "flow_not_found" },
        };
      }

      const tenantKey = resolveTenantKey();
      const result = await runner.start(params.sessionKey, tenantKey, params.flowName, flow);

      if (result.kind === "error") {
        return {
          content: [{ type: "text" as const, text: result.reason }],
          details: { error: result.reason },
        };
      }

      if (result.kind === "next_question") {
        return {
          content: [{ type: "text" as const, text: result.question }],
          details: { step: result.stepIndex, totalSteps: result.totalSteps, question: result.question },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Fluxo iniciado." }],
        details: {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: capture_step
// ---------------------------------------------------------------------------

export function createCaptureStepTool(
  runner: FlowRunner,
  cfg: ForChatConfig,
) {
  return {
    name: "capture_step",
    label: "Registrar etapa do fluxo",
    description:
      "Registra a resposta do usuário para a etapa atual do fluxo de captura e avança para a próxima. " +
      "Chame imediatamente após o usuário fornecer a informação solicitada. " +
      "Retorna a próxima pergunta ou, se for a última etapa, um resumo para confirmação.",
    parameters: Type.Object({
      sessionKey: Type.String({ description: "Chave da sessão atual" }),
      fieldName: Type.String({ description: "Nome do campo sendo coletado (ex: nome, email, produto)" }),
      value: Type.String({ description: "Valor fornecido pelo usuário" }),
    }),
    async execute(_toolCallId: string, params: { sessionKey: string; fieldName: string; value: string }) {
      const state = await runner.getState(params.sessionKey);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "Nenhum fluxo ativo. Use capture_start para iniciar." }],
          details: { error: "no_active_flow" },
        };
      }

      const flow = cfg.flows[state.flowName];
      if (!flow) {
        return {
          content: [{ type: "text" as const, text: `Fluxo '${state.flowName}' não encontrado na configuração.` }],
          details: { error: "flow_not_found" },
        };
      }

      const result = await runner.advance(params.sessionKey, params.value, flow);

      if (result.kind === "error") {
        return {
          content: [{ type: "text" as const, text: result.reason }],
          details: { error: result.reason },
        };
      }

      if (result.kind === "next_question") {
        return {
          content: [{ type: "text" as const, text: result.question }],
          details: { step: result.stepIndex, totalSteps: result.totalSteps },
        };
      }

      if (result.kind === "summary") {
        return {
          content: [{ type: "text" as const, text: result.summary }],
          details: { kind: "summary", data: result.data },
        };
      }

      return {
        content: [{ type: "text" as const, text: "Etapa registrada." }],
        details: {},
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tool: capture_confirm
// ---------------------------------------------------------------------------

export function createCaptureConfirmTool(
  runner: FlowRunner,
  cfg: ForChatConfig,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
) {
  return {
    name: "capture_confirm",
    label: "Confirmar ou cancelar fluxo",
    description:
      "Confirma os dados coletados e envia via webhook, ou cancela o fluxo. " +
      "Chame após o usuário confirmar ou negar o resumo apresentado.",
    parameters: Type.Object({
      sessionKey: Type.String({ description: "Chave da sessão atual" }),
      confirmed: Type.Boolean({ description: "true = confirmar e enviar, false = cancelar" }),
    }),
    async execute(_toolCallId: string, params: { sessionKey: string; confirmed: boolean }) {
      const state = await runner.getState(params.sessionKey);
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "Nenhum fluxo ativo para confirmar." }],
          details: { error: "no_active_flow" },
        };
      }

      const flow = cfg.flows[state.flowName];
      const { data, message } = await runner.confirm(
        params.sessionKey,
        params.confirmed,
        flow ?? { name: state.flowName, description: "", steps: [], confirmationMessage: "", successMessage: "" },
      );

      if (!params.confirmed || !data) {
        return {
          content: [{ type: "text" as const, text: "Tudo bem! O fluxo foi cancelado. Posso ajudar com mais alguma coisa?" }],
          details: { cancelled: true },
        };
      }

      // Deliver to webhooks
      const payload: DeliveryPayload = {
        flow: state.flowName,
        sessionKey: params.sessionKey,
        tenantKey: state.tenantKey,
        timestamp: Date.now(),
        data,
      };

      const results = await deliverToWebhooks(cfg.delivery.webhooks, payload);
      const failed = results.filter((r) => !r.ok);

      if (failed.length > 0) {
        logger.warn(`[forchat] Webhook delivery failed for ${failed.length} target(s): ${failed.map((r) => r.url).join(", ")}`);
      } else if (results.length > 0) {
        logger.info(`[forchat] Delivered to ${results.length} webhook(s) for flow '${state.flowName}'`);
      }

      return {
        content: [{ type: "text" as const, text: message }],
        details: { delivered: true, webhookResults: results, data },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Register all tools
// ---------------------------------------------------------------------------

export function registerForChatTools(
  api: OpenClawPluginApi,
  faqService: FaqService,
  runner: FlowRunner,
  cfg: ForChatConfig,
  resolveTenantKey: () => string,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerTool(createFaqSearchTool(faqService, resolveTenantKey) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerTool(createCaptureStartTool(runner, cfg, resolveTenantKey) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerTool(createCaptureStepTool(runner, cfg) as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.registerTool(createCaptureConfirmTool(runner, cfg, api.logger) as any);
}
