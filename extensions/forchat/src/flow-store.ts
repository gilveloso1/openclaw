import path from "node:path";
import type { FlowDefinition } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowState = {
  flowName: string;
  /** Zero-based index of the current step */
  currentStep: number;
  /** Field values collected so far, keyed by step.field */
  collectedData: Record<string, string>;
  startedAt: number;
  tenantKey: string;
};

type SessionFlowFile = {
  state: FlowState | null;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// FlowStore — persists one active flow per session
// ---------------------------------------------------------------------------

export class FlowStore {
  constructor(
    private readonly stateDir: string,
    private readonly readJson: <T>(path: string, fallback: T) => Promise<{ value: T }>,
    private readonly writeJson: (path: string, value: unknown) => Promise<void>,
  ) {}

  private filePath(sessionKey: string): string {
    // Sanitize sessionKey to be a safe filename
    const safe = sessionKey.replace(/[^a-z0-9_\-.@]/gi, "_");
    return path.join(this.stateDir, "flows", `${safe}.json`);
  }

  async get(sessionKey: string): Promise<FlowState | null> {
    const { value } = await this.readJson<SessionFlowFile>(this.filePath(sessionKey), {
      state: null,
      updatedAt: 0,
    });
    return value.state;
  }

  async set(sessionKey: string, state: FlowState): Promise<void> {
    await this.writeJson(this.filePath(sessionKey), {
      state,
      updatedAt: Date.now(),
    });
  }

  async clear(sessionKey: string): Promise<void> {
    await this.writeJson(this.filePath(sessionKey), {
      state: null,
      updatedAt: Date.now(),
    });
  }

  async hasActive(sessionKey: string): Promise<boolean> {
    const state = await this.get(sessionKey);
    return state !== null;
  }
}

// ---------------------------------------------------------------------------
// FlowRunner — state machine operations (pure, no side effects)
// ---------------------------------------------------------------------------

export type FlowStepResult =
  | { kind: "next_question"; question: string; stepIndex: number; totalSteps: number }
  | { kind: "summary"; summary: string; data: Record<string, string> }
  | { kind: "done"; message: string }
  | { kind: "error"; reason: string };

export class FlowRunner {
  constructor(private readonly store: FlowStore) {}

  /** Start a new flow. Returns the first question. */
  async start(
    sessionKey: string,
    tenantKey: string,
    flowName: string,
    flow: FlowDefinition,
  ): Promise<FlowStepResult> {
    if (flow.steps.length === 0) {
      return { kind: "error", reason: `Fluxo '${flowName}' não tem etapas definidas.` };
    }

    const state: FlowState = {
      flowName,
      currentStep: 0,
      collectedData: {},
      startedAt: Date.now(),
      tenantKey,
    };
    await this.store.set(sessionKey, state);

    const step = flow.steps[0];
    return {
      kind: "next_question",
      question: step.question,
      stepIndex: 0,
      totalSteps: flow.steps.length,
    };
  }

  /** Record an answer for the current step and advance. */
  async advance(
    sessionKey: string,
    value: string,
    flow: FlowDefinition,
  ): Promise<FlowStepResult> {
    const state = await this.store.get(sessionKey);
    if (!state) {
      return { kind: "error", reason: "Nenhum fluxo ativo para essa sessão." };
    }

    const step = flow.steps[state.currentStep];
    if (!step) {
      return { kind: "error", reason: "Etapa inválida no fluxo." };
    }

    // Record the value
    state.collectedData[step.field] = value.trim();
    state.currentStep += 1;
    await this.store.set(sessionKey, state);

    const nextStep = flow.steps[state.currentStep];

    // All steps collected — show summary
    if (!nextStep) {
      return {
        kind: "summary",
        summary: buildSummary(flow, state.collectedData),
        data: { ...state.collectedData },
      };
    }

    return {
      kind: "next_question",
      question: nextStep.question,
      stepIndex: state.currentStep,
      totalSteps: flow.steps.length,
    };
  }

  /** Confirm (deliver) or cancel the current flow. */
  async confirm(
    sessionKey: string,
    confirmed: boolean,
    flow: FlowDefinition,
  ): Promise<{ data: Record<string, string> | null; message: string }> {
    const state = await this.store.get(sessionKey);
    await this.store.clear(sessionKey);

    if (!confirmed || !state) {
      return { data: null, message: "Fluxo cancelado." };
    }

    return {
      data: { ...state.collectedData },
      message: flow.successMessage ?? "Informações enviadas com sucesso!",
    };
  }

  async cancel(sessionKey: string): Promise<void> {
    await this.store.clear(sessionKey);
  }

  async getState(sessionKey: string): Promise<FlowState | null> {
    return this.store.get(sessionKey);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(flow: FlowDefinition, data: Record<string, string>): string {
  const lines = flow.steps.map((step) => {
    const value = data[step.field] ?? "(não informado)";
    return `• ${step.label}: ${value}`;
  });
  const template = flow.confirmationMessage ?? "Confirma as informações abaixo?";
  return `${template}\n\n${lines.join("\n")}`;
}

/** Builds context text to inject via before_agent_start when a flow is active. */
export function buildFlowContext(state: FlowState, flow: FlowDefinition): string {
  const step = flow.steps[state.currentStep];
  if (!step) return "";

  const collected = flow.steps
    .slice(0, state.currentStep)
    .map((s) => `  • ${s.label}: ${state.collectedData[s.field] ?? "(não informado)"}`)
    .join("\n");

  return [
    `<forchat-flow>`,
    `Você está conduzindo um fluxo de captura: "${flow.name}".`,
    `Etapa atual (${state.currentStep + 1}/${flow.steps.length}): ${step.label}`,
    `Pergunta a fazer: "${step.question}"`,
    collected ? `\nDados já coletados:\n${collected}` : "",
    `\nInstruções:`,
    `- Faça a pergunta acima de forma natural e amigável.`,
    `- Quando o usuário responder, chame a ferramenta capture_step com field="${step.field}" e o valor fornecido.`,
    `- Não avance para a próxima etapa sem chamar capture_step.`,
    `</forchat-flow>`,
  ]
    .filter(Boolean)
    .join("\n");
}
