import { hashEmbedding, SQLITE_VECTOR_DIMENSIONS } from "./semantic-embedding-hash.js";

type NodeLlamaCppModule = typeof import("node-llama-cpp");
type LlamaInstance = Awaited<ReturnType<NodeLlamaCppModule["getLlama"]>>;
type LlamaModelInstance = Awaited<ReturnType<LlamaInstance["loadModel"]>>;
type LlamaEmbeddingContextInstance = Awaited<ReturnType<LlamaModelInstance["createEmbeddingContext"]>>;

export interface SemanticEmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
  dispose(): Promise<void>;
}

class HashEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly model = "oms-sqlite-vec-hash-v1";

  async embed(text: string): Promise<Float32Array> {
    return hashEmbedding(text);
  }

  async dispose(): Promise<void> {
    return undefined;
  }
}

class LlamaEmbeddingProvider implements SemanticEmbeddingProvider {
  readonly model: string;

  private constructor(
    modelPath: string,
    private readonly llamaModel: LlamaModelInstance,
    private readonly context: LlamaEmbeddingContextInstance,
  ) {
    this.model = `node-llama-cpp:${modelPath}`;
  }

  static async create(modelPath: string): Promise<LlamaEmbeddingProvider> {
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createEmbeddingContext();
    return new LlamaEmbeddingProvider(modelPath, model, context);
  }

  async embed(text: string): Promise<Float32Array> {
    const embedding = await this.context.getEmbeddingFor(text);
    return projectEmbeddingVector(embedding.vector);
  }

  async dispose(): Promise<void> {
    await this.context.dispose();
    await this.llamaModel.dispose();
  }
}

export function projectEmbeddingVector(values: readonly number[]): Float32Array {
  const vector = new Float32Array(SQLITE_VECTOR_DIMENSIONS);
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? 0;
    if (Number.isFinite(value)) {
      vector[index % SQLITE_VECTOR_DIMENSIONS] = (vector[index % SQLITE_VECTOR_DIMENSIONS] ?? 0) + value;
    }
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  if (magnitude === 0) return vector;
  const divisor = Math.sqrt(magnitude);
  for (let index = 0; index < vector.length; index++) {
    vector[index] = (vector[index] ?? 0) / divisor;
  }
  return vector;
}

export async function createSemanticEmbeddingProvider(opts: {
  readonly modelPath?: string;
}): Promise<SemanticEmbeddingProvider> {
  return opts.modelPath ? LlamaEmbeddingProvider.create(opts.modelPath) : new HashEmbeddingProvider();
}
