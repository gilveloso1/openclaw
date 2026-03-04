import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import type { EmbeddingConfig, FaqConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FaqStatus = "approved" | "suggested" | "rejected";

export type Faq = {
  id: string;
  question: string;
  answer: string;
  status: FaqStatus;
  createdAt: number;
  updatedAt: number;
  tenantKey: string;
  suggestedFromSession?: string;
};

export type FaqStore = {
  faqs: Faq[];
  version: number;
};

type VectorRow = {
  id: string;
  vector: number[];
  tenantKey: string;
};

// ---------------------------------------------------------------------------
// Embeddings client
// ---------------------------------------------------------------------------

let OpenAI: typeof import("openai").default | null = null;

async function loadOpenAI() {
  if (!OpenAI) {
    const mod = await import("openai");
    OpenAI = mod.default;
  }
  return OpenAI;
}

export class FaqEmbeddings {
  private client: import("openai").default | null = null;

  constructor(private readonly cfg: EmbeddingConfig) {}

  private async getClient(): Promise<import("openai").default> {
    if (!this.client) {
      const Cls = await loadOpenAI();
      this.client = new Cls({
        apiKey: this.cfg.apiKey,
        baseURL: this.cfg.baseUrl,
      });
    }
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    const client = await this.getClient();
    const params: Parameters<typeof client.embeddings.create>[0] = {
      model: this.cfg.model,
      input: text,
    };
    if (this.cfg.dimensions) {
      params.dimensions = this.cfg.dimensions;
    }
    const res = await client.embeddings.create(params);
    return res.data[0].embedding;
  }
}

// ---------------------------------------------------------------------------
// LanceDB vector store
// ---------------------------------------------------------------------------

const TABLE_NAME = "faq_vectors";

let lancedbPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

async function loadLanceDB() {
  if (!lancedbPromise) {
    lancedbPromise = import("@lancedb/lancedb");
  }
  return lancedbPromise;
}

export class FaqVectorStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly vectorDim: number,
  ) {}

  private async ensureInit(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      const schema: VectorRow = {
        id: "__schema__",
        vector: Array.from({ length: this.vectorDim }).fill(0) as number[],
        tenantKey: "",
      };
      this.table = await this.db.createTable(TABLE_NAME, [schema]);
      await this.table.delete('id = "__schema__"');
    }
  }

  async upsert(id: string, vector: number[], tenantKey: string): Promise<void> {
    await this.ensureInit();
    await this.table!.delete(`id = '${id}'`);
    await this.table!.add([{ id, vector, tenantKey }]);
  }

  async search(
    vector: number[],
    tenantKey: string,
    limit: number,
    threshold: number,
  ): Promise<Array<{ id: string; score: number }>> {
    await this.ensureInit();
    const results = await this.table!.vectorSearch(vector).limit(limit * 3).toArray();

    return results
      .filter((r) => r.tenantKey === tenantKey)
      .map((r) => ({
        id: r.id as string,
        score: 1 / (1 + (r._distance ?? 0)),
      }))
      .filter((r) => r.score >= threshold)
      .slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    await this.ensureInit();
    await this.table!.delete(`id = '${id}'`);
  }
}

// ---------------------------------------------------------------------------
// FAQ metadata store (JSON)
// ---------------------------------------------------------------------------

export class FaqMetaStore {
  constructor(
    private readonly filePath: string,
    private readonly readJson: <T>(path: string, fallback: T) => Promise<{ value: T }>,
    private readonly writeJson: (path: string, value: unknown) => Promise<void>,
  ) {}

  private async load(): Promise<FaqStore> {
    const { value } = await this.readJson<FaqStore>(this.filePath, {
      faqs: [],
      version: 1,
    });
    return value;
  }

  private async save(store: FaqStore): Promise<void> {
    await this.writeJson(this.filePath, store);
  }

  async list(tenantKey: string, status?: FaqStatus): Promise<Faq[]> {
    const store = await this.load();
    return store.faqs.filter(
      (f) => f.tenantKey === tenantKey && (status == null || f.status === status),
    );
  }

  async get(id: string): Promise<Faq | null> {
    const store = await this.load();
    return store.faqs.find((f) => f.id === id) ?? null;
  }

  async create(
    tenantKey: string,
    data: { question: string; answer: string; status: FaqStatus; suggestedFromSession?: string },
  ): Promise<Faq> {
    const store = await this.load();
    const faq: Faq = {
      id: randomUUID(),
      tenantKey,
      question: data.question,
      answer: data.answer,
      status: data.status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      suggestedFromSession: data.suggestedFromSession,
    };
    store.faqs.push(faq);
    await this.save(store);
    return faq;
  }

  async update(id: string, patch: Partial<Pick<Faq, "question" | "answer" | "status">>): Promise<Faq | null> {
    const store = await this.load();
    const idx = store.faqs.findIndex((f) => f.id === id);
    if (idx === -1) return null;
    store.faqs[idx] = { ...store.faqs[idx], ...patch, updatedAt: Date.now() };
    await this.save(store);
    return store.faqs[idx];
  }

  async delete(id: string): Promise<boolean> {
    const store = await this.load();
    const before = store.faqs.length;
    store.faqs = store.faqs.filter((f) => f.id !== id);
    if (store.faqs.length === before) return false;
    await this.save(store);
    return true;
  }
}

// ---------------------------------------------------------------------------
// High-level FaqService — combines meta + vectors
// ---------------------------------------------------------------------------

export class FaqService {
  constructor(
    private readonly meta: FaqMetaStore,
    private readonly vectors: FaqVectorStore,
    private readonly embeddings: FaqEmbeddings,
    private readonly cfg: FaqConfig,
  ) {}

  async search(
    tenantKey: string,
    query: string,
    limit?: number,
  ): Promise<Array<{ faq: Faq; score: number }>> {
    const maxItems = limit ?? this.cfg.maxContextItems;
    let vector: number[];
    try {
      vector = await this.embeddings.embed(query);
    } catch {
      // Embedding unavailable — fall back to keyword match
      const faqs = await this.meta.list(tenantKey, "approved");
      const q = query.toLowerCase();
      return faqs
        .filter((f) => f.question.toLowerCase().includes(q) || f.answer.toLowerCase().includes(q))
        .slice(0, maxItems)
        .map((faq) => ({ faq, score: 0.5 }));
    }

    const hits = await this.vectors.search(vector, tenantKey, maxItems, this.cfg.searchThreshold);
    const results: Array<{ faq: Faq; score: number }> = [];

    for (const hit of hits) {
      const faq = await this.meta.get(hit.id);
      if (faq && faq.status === "approved") {
        results.push({ faq, score: hit.score });
      }
    }
    return results;
  }

  async addFaq(
    tenantKey: string,
    question: string,
    answer: string,
    status: FaqStatus = "approved",
    suggestedFromSession?: string,
  ): Promise<Faq> {
    const faq = await this.meta.create(tenantKey, { question, answer, status, suggestedFromSession });
    try {
      const vector = await this.embeddings.embed(`${question} ${answer}`);
      await this.vectors.upsert(faq.id, vector, tenantKey);
    } catch {
      // Store without vector — keyword fallback still works
    }
    return faq;
  }

  async updateFaq(
    id: string,
    patch: Partial<Pick<Faq, "question" | "answer" | "status">>,
  ): Promise<Faq | null> {
    const updated = await this.meta.update(id, patch);
    if (!updated) return null;
    // Re-embed if text changed
    if (patch.question || patch.answer) {
      try {
        const vector = await this.embeddings.embed(`${updated.question} ${updated.answer}`);
        await this.vectors.upsert(updated.id, vector, updated.tenantKey);
      } catch {
        // Best effort
      }
    }
    return updated;
  }

  async deleteFaq(id: string): Promise<boolean> {
    const deleted = await this.meta.delete(id);
    if (deleted) {
      await this.vectors.delete(id).catch(() => undefined);
    }
    return deleted;
  }

  async list(tenantKey: string, status?: FaqStatus): Promise<Faq[]> {
    return this.meta.list(tenantKey, status);
  }

  async get(id: string): Promise<Faq | null> {
    return this.meta.get(id);
  }
}
