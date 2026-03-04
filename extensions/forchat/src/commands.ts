import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk";
import type { ForChatConfig } from "./config.js";
import type { FaqService } from "./faq-store.js";
import type { FlowRunner } from "./flow-store.js";

// ---------------------------------------------------------------------------
// /faq commands
// ---------------------------------------------------------------------------

function buildFaqCommands(
  faqService: FaqService,
  resolveTenantKey: (ctx: { channelId?: string; accountId?: string }) => string,
): OpenClawPluginCommandDefinition[] {
  return [
    {
      name: "faq",
      description: "Gerencia a base de conhecimento. Use: /faq list | /faq add <P> | <R> | /faq approve <id> | /faq reject <id>",
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const args = ctx.args?.trim() ?? "";
        const tenantKey = resolveTenantKey(ctx);

        // /faq  or  /faq list
        if (!args || args === "list") {
          const faqs = await faqService.list(tenantKey, "approved");
          if (faqs.length === 0) {
            return { text: "Nenhuma FAQ cadastrada ainda. Use /faq add <pergunta> | <resposta> para adicionar." };
          }
          const lines = faqs.map((f, i) => `${i + 1}. [${f.id.slice(0, 6)}] ${f.question}`);
          return { text: `*Base de conhecimento (${faqs.length} entradas):*\n${lines.join("\n")}` };
        }

        // /faq add <pergunta> | <resposta>
        if (args.startsWith("add ")) {
          if (!ctx.isAuthorizedSender) {
            return { text: "Apenas usuários autorizados podem adicionar FAQs." };
          }
          const rest = args.slice(4).trim();
          const sep = rest.indexOf("|");
          if (sep === -1) {
            return { text: "Formato: /faq add <pergunta> | <resposta>" };
          }
          const question = rest.slice(0, sep).trim();
          const answer = rest.slice(sep + 1).trim();
          if (!question || !answer) {
            return { text: "Pergunta e resposta não podem estar vazias." };
          }
          const faq = await faqService.addFaq(tenantKey, question, answer, "approved");
          return { text: `FAQ adicionada com sucesso! ID: ${faq.id.slice(0, 8)}` };
        }

        // /faq approve <id>
        if (args.startsWith("approve ")) {
          if (!ctx.isAuthorizedSender) {
            return { text: "Apenas usuários autorizados podem aprovar FAQs." };
          }
          const id = args.slice(8).trim();
          const updated = await faqService.updateFaq(id, { status: "approved" });
          if (!updated) return { text: `FAQ não encontrada: ${id}` };
          return { text: `FAQ aprovada: "${updated.question}"` };
        }

        // /faq reject <id>
        if (args.startsWith("reject ")) {
          if (!ctx.isAuthorizedSender) {
            return { text: "Apenas usuários autorizados podem rejeitar FAQs." };
          }
          const id = args.slice(7).trim();
          const updated = await faqService.updateFaq(id, { status: "rejected" });
          if (!updated) return { text: `FAQ não encontrada: ${id}` };
          return { text: `FAQ rejeitada: "${updated.question}"` };
        }

        // /faq suggestions
        if (args === "suggestions") {
          if (!ctx.isAuthorizedSender) {
            return { text: "Apenas usuários autorizados podem ver sugestões." };
          }
          const suggestions = await faqService.list(tenantKey, "suggested");
          if (suggestions.length === 0) {
            return { text: "Nenhuma sugestão pendente." };
          }
          const lines = suggestions.map(
            (f, i) => `${i + 1}. [${f.id.slice(0, 8)}] ${f.question}`,
          );
          return { text: `*Sugestões pendentes (${suggestions.length}):*\n${lines.join("\n")}\n\nUse /faq approve <id> ou /faq reject <id>` };
        }

        // /faq delete <id>
        if (args.startsWith("delete ")) {
          if (!ctx.isAuthorizedSender) {
            return { text: "Apenas usuários autorizados podem excluir FAQs." };
          }
          const id = args.slice(7).trim();
          const deleted = await faqService.deleteFaq(id);
          if (!deleted) return { text: `FAQ não encontrada: ${id}` };
          return { text: `FAQ excluída.` };
        }

        return {
          text: [
            "*Comandos disponíveis:*",
            "/faq list — lista todas as FAQs",
            "/faq add <pergunta> | <resposta> — adiciona FAQ",
            "/faq suggestions — lista sugestões pendentes",
            "/faq approve <id> — aprova uma sugestão",
            "/faq reject <id> — rejeita uma sugestão",
            "/faq delete <id> — exclui uma FAQ",
          ].join("\n"),
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// /flow commands
// ---------------------------------------------------------------------------

function buildFlowCommands(
  runner: FlowRunner,
  cfg: ForChatConfig,
  resolveTenantKey: (ctx: { channelId?: string; accountId?: string }) => string,
): OpenClawPluginCommandDefinition[] {
  const flowNames = Object.keys(cfg.flows);

  return [
    {
      name: "flow",
      description: `Inicia ou gerencia um fluxo de captura. Use: /flow list | /flow start <nome> | /flow cancel`,
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const args = ctx.args?.trim() ?? "";
        const sessionKey = [ctx.channel, ctx.accountId, ctx.from].filter(Boolean).join(":");

        // /flow  or  /flow list
        if (!args || args === "list") {
          if (flowNames.length === 0) {
            return { text: "Nenhum fluxo configurado." };
          }
          const lines = flowNames.map((name) => {
            const flow = cfg.flows[name];
            return `• *${name}* — ${flow.description || flow.name} (${flow.steps.length} etapas)`;
          });
          return { text: `*Fluxos disponíveis:*\n${lines.join("\n")}\n\nUse /flow start <nome> para iniciar.` };
        }

        // /flow start <nome>
        if (args.startsWith("start ")) {
          const flowName = args.slice(6).trim();
          const flow = cfg.flows[flowName];
          if (!flow) {
            return { text: `Fluxo '${flowName}' não encontrado. Disponíveis: ${flowNames.join(", ")}` };
          }

          const tenantKey = resolveTenantKey(ctx);
          const result = await runner.start(sessionKey, tenantKey, flowName, flow);

          if (result.kind === "error") return { text: result.reason };
          if (result.kind === "next_question") {
            return { text: `*${flow.name}* — etapa ${result.stepIndex + 1} de ${result.totalSteps}\n\n${result.question}` };
          }
          return { text: "Fluxo iniciado." };
        }

        // /flow cancel
        if (args === "cancel") {
          const state = await runner.getState(sessionKey);
          if (!state) return { text: "Nenhum fluxo ativo para cancelar." };
          await runner.cancel(sessionKey);
          return { text: "Fluxo cancelado." };
        }

        // /flow status
        if (args === "status") {
          const state = await runner.getState(sessionKey);
          if (!state) return { text: "Nenhum fluxo ativo nesta sessão." };
          const flow = cfg.flows[state.flowName];
          const stepLabel = flow?.steps[state.currentStep]?.label ?? "Desconhecida";
          return {
            text: `*Fluxo ativo:* ${state.flowName}\n*Etapa atual:* ${state.currentStep + 1} — ${stepLabel}\n*Dados coletados:* ${Object.keys(state.collectedData).length}`,
          };
        }

        return {
          text: [
            "*Comandos de fluxo:*",
            "/flow list — lista fluxos disponíveis",
            "/flow start <nome> — inicia um fluxo",
            "/flow status — mostra o fluxo ativo",
            "/flow cancel — cancela o fluxo atual",
          ].join("\n"),
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Register all commands
// ---------------------------------------------------------------------------

export function registerForChatCommands(
  api: OpenClawPluginApi,
  faqService: FaqService,
  runner: FlowRunner,
  cfg: ForChatConfig,
  resolveTenantKey: (ctx: { channelId?: string; accountId?: string }) => string,
) {
  for (const cmd of buildFaqCommands(faqService, resolveTenantKey)) {
    api.registerCommand(cmd);
  }
  for (const cmd of buildFlowCommands(runner, cfg, resolveTenantKey)) {
    api.registerCommand(cmd);
  }
}
