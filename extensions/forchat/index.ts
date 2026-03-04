import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import { forchatConfigSchema, resolveTenantKey } from "./src/config.js";
import { FaqEmbeddings, FaqMetaStore, FaqService, FaqVectorStore } from "./src/faq-store.js";
import { FlowRunner, FlowStore } from "./src/flow-store.js";
import { registerForChatTools } from "./src/tools.js";
import { registerForChatCommands } from "./src/commands.js";
import { registerContextHook, registerFeedbackHook } from "./src/hooks.js";
import { createAdminHandler } from "./src/http.js";

const plugin = {
  id: "forchat",
  name: "ForChat",
  description: "Motor de conhecimento e captura de intenção para assistentes empresariais",
  configSchema: forchatConfigSchema,

  register(api: OpenClawPluginApi) {
    // ------------------------------------------------------------------
    // Config
    // ------------------------------------------------------------------
    const cfg = forchatConfigSchema.parse(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir("forchat");
    const storageBase = cfg.storagePath ? api.resolvePath(cfg.storagePath) : stateDir;

    // ------------------------------------------------------------------
    // FAQ service
    // ------------------------------------------------------------------
    const faqMetaPath = path.join(storageBase, "faqs.json");
    const vectorDbPath = path.join(storageBase, "vectors");
    const vectorDim = cfg.embedding.dimensions ?? 1536; // default for text-embedding-3-small

    const embeddings = new FaqEmbeddings(cfg.embedding);
    const metaStore = new FaqMetaStore(
      faqMetaPath,
      readJsonFileWithFallback,
      writeJsonFileAtomically,
    );
    const vectorStore = new FaqVectorStore(vectorDbPath, vectorDim);
    const faqService = new FaqService(metaStore, vectorStore, embeddings, cfg.faq);

    // ------------------------------------------------------------------
    // Flow runner
    // ------------------------------------------------------------------
    const flowStore = new FlowStore(storageBase, readJsonFileWithFallback, writeJsonFileAtomically);
    const flowRunner = new FlowRunner(flowStore);

    // ------------------------------------------------------------------
    // Tenant key resolver
    // ------------------------------------------------------------------
    // When ctx provides channelId + accountId, we scope per tenant.
    // Fallback: use plugin id as a single-tenant key.
    const resolveTenant = (channelId?: string, accountId?: string): string => {
      if (channelId && accountId) return resolveTenantKey(channelId, accountId);
      if (channelId) return resolveTenantKey(channelId, "default");
      return resolveTenantKey("default", "default");
    };

    // ------------------------------------------------------------------
    // Tools (for the AI agent)
    // ------------------------------------------------------------------
    registerForChatTools(
      api,
      faqService,
      flowRunner,
      cfg,
      // resolveTenantKey without ctx — tools run within a session context
      // where channelId/accountId are not directly available; use default tenant
      () => resolveTenant(),
    );

    // ------------------------------------------------------------------
    // Commands (/faq, /flow — bypass LLM)
    // ------------------------------------------------------------------
    registerForChatCommands(
      api,
      faqService,
      flowRunner,
      cfg,
      (ctx) => resolveTenant(ctx.channelId, ctx.accountId),
    );

    // ------------------------------------------------------------------
    // Hooks
    // ------------------------------------------------------------------
    registerContextHook(api, faqService, flowRunner, cfg, (channelId) =>
      resolveTenant(channelId),
    );
    registerFeedbackHook(api, faqService, cfg.faq, (channelId) =>
      resolveTenant(channelId),
    );

    // ------------------------------------------------------------------
    // Admin HTTP routes
    // ------------------------------------------------------------------
    const defaultTenant = resolveTenant();
    const adminHandler = createAdminHandler(faqService, cfg, defaultTenant);

    api.registerHttpRoute({
      path: "/plugins/forchat",
      auth: "gateway",
      match: "prefix",
      handler: adminHandler,
    });

    // ------------------------------------------------------------------
    // Service lifecycle
    // ------------------------------------------------------------------
    api.registerService({
      id: "forchat",
      start() {
        api.logger.info(
          `[forchat] Plugin iniciado — armazenamento: ${storageBase} | fluxos: ${Object.keys(cfg.flows).join(", ") || "nenhum"}`,
        );
      },
      stop() {
        api.logger.info("[forchat] Plugin encerrado.");
      },
    });
  },
};

export default plugin;
