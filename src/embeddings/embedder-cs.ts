type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let extractor: FeatureExtractor | null = null;
let extractorPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  if (extractor) return extractor;
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        const mod = await import('@xenova/transformers');
        mod.env.allowLocalModels = false;
        mod.env.useBrowserCache = true;
        const created = (await (
          mod.pipeline as unknown as (
            task: string,
            model: string,
            options: { quantized: boolean },
          ) => Promise<FeatureExtractor>
        )(
          'feature-extraction',
          'Xenova/bge-small-en-v1.5',
          { quantized: true },
        )) as FeatureExtractor;
        extractor = created;
        return created;
      } catch (err) {
        // Allow retry on next call instead of caching the failure forever.
        extractorPromise = null;
        throw new Error(
          `embedder-cs: failed to load bge-small-en-v1.5 — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    })();
  }
  return extractorPromise;
}

// Serialize calls so the ONNX session is never re-entered.
let queue: Promise<unknown> = Promise.resolve();

export function embedInContentScript(text: string): Promise<Float32Array> {
  const trimmed = text?.trim() ?? '';
  if (!trimmed) {
    return Promise.reject(new Error('embedInContentScript: empty input'));
  }

  const next = queue.then(async () => {
    const ext = await loadExtractor();
    try {
      const output = await ext(trimmed, { pooling: 'mean', normalize: true });
      return output.data instanceof Float32Array
        ? output.data
        : new Float32Array(output.data);
    } catch (err) {
      throw new Error(
        `embedInContentScript: inference failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });

  // Keep the queue alive even if this call rejects.
  queue = next.catch(() => undefined);
  return next;
}
