import { z } from "zod";

// ---------------------------------------------------------------------------
// Flow step definition
// ---------------------------------------------------------------------------

export const FlowStepSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  question: z.string().min(1),
  type: z.enum(["text", "email", "phone", "number"]).optional().default("text"),
  required: z.boolean().optional().default(true),
});

export type FlowStep = z.infer<typeof FlowStepSchema>;

// ---------------------------------------------------------------------------
// Flow definition
// ---------------------------------------------------------------------------

export const FlowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  steps: z.array(FlowStepSchema).min(1),
  confirmationMessage: z
    .string()
    .optional()
    .default("Confirma as informações acima?"),
  successMessage: z
    .string()
    .optional()
    .default("Informações enviadas com sucesso! Em breve entraremos em contato."),
});

export type FlowDefinition = z.infer<typeof FlowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Webhook delivery target
// ---------------------------------------------------------------------------

export const WebhookTargetSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional().default({}),
});

export type WebhookTarget = z.infer<typeof WebhookTargetSchema>;

// ---------------------------------------------------------------------------
// Embedding config
// ---------------------------------------------------------------------------

export const EmbeddingConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().default("text-embedding-3-small"),
  baseUrl: z.string().url().optional(),
  dimensions: z.number().int().positive().optional(),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

// ---------------------------------------------------------------------------
// FAQ config
// ---------------------------------------------------------------------------

export const FaqConfigSchema = z.object({
  maxContextItems: z.number().int().min(1).max(20).default(5),
  searchThreshold: z.number().min(0).max(1).default(0.3),
  autoSuggest: z.boolean().default(true),
});

export type FaqConfig = z.infer<typeof FaqConfigSchema>;

// ---------------------------------------------------------------------------
// Full ForChat config
// ---------------------------------------------------------------------------

export const ForChatConfigSchema = z.object({
  embedding: EmbeddingConfigSchema,
  flows: z.record(FlowDefinitionSchema).default({}),
  delivery: z.object({
    webhooks: z.array(WebhookTargetSchema).default([]),
  }).default({}),
  faq: FaqConfigSchema.default({}),
  storagePath: z.string().optional(),
});

export type ForChatConfig = z.infer<typeof ForChatConfigSchema>;

// ---------------------------------------------------------------------------
// Plugin config schema adapter (plugin-sdk format)
// ---------------------------------------------------------------------------

export const forchatConfigSchema = {
  parse(value: unknown): ForChatConfig {
    return ForChatConfigSchema.parse(value ?? {});
  },
  safeParse(value: unknown) {
    return ForChatConfigSchema.safeParse(value ?? {});
  },
  uiHints: {
    "embedding.apiKey": { label: "API Key de Embeddings", sensitive: true },
    "embedding.model": { label: "Modelo de Embeddings", placeholder: "text-embedding-3-small" },
    "embedding.baseUrl": { label: "Base URL (Ollama/alternativas)", advanced: true },
    "faq.maxContextItems": { label: "Máx. FAQs no contexto", advanced: true },
    "faq.searchThreshold": { label: "Limiar de similaridade (0-1)", advanced: true },
    "faq.autoSuggest": { label: "Sugerir FAQs automaticamente" },
    storagePath: { label: "Caminho de armazenamento", advanced: true },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves a tenant key from channelId + accountId for data isolation. */
export function resolveTenantKey(channelId: string, accountId: string): string {
  const channel = channelId.trim().toLowerCase();
  const account = accountId.trim().toLowerCase();
  return `${channel}:${account}`;
}
