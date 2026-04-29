import { type LanguageModelV3 } from '@ai-sdk/provider';
import { type LanguageModelMiddleware } from 'ai';

export const GEMINI_MODEL_FALLBACKS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
] as const;

type GeminiAttempt = {
  model: string;
  status?: number;
  message: string;
};

export class GeminiFallbackError extends Error {
  attempts: GeminiAttempt[];

  constructor(attempts: GeminiAttempt[]) {
    super('Gemini is temporarily unavailable across all configured fallback models.');
    this.name = 'GeminiFallbackError';
    this.attempts = attempts;
  }
}

function extractErrorDetails(error: unknown): { status?: number; message: string } {
  if (error && typeof error === 'object') {
    const err = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      data?: { error?: { message?: unknown; code?: unknown } };
      error?: { message?: unknown; code?: unknown };
      message?: unknown;
    };
    const status =
      typeof err.status === 'number'
        ? err.status
        : typeof err.statusCode === 'number'
          ? err.statusCode
          : typeof err.response?.status === 'number'
            ? err.response.status
            : typeof err.data?.error?.code === 'number'
              ? err.data.error.code
              : typeof err.error?.code === 'number'
                ? err.error.code
                : undefined;
    const message =
      typeof err.data?.error?.message === 'string'
        ? err.data.error.message
        : typeof err.error?.message === 'string'
          ? err.error.message
          : typeof err.message === 'string'
            ? err.message
            : String(error);

    return { status, message };
  }

  return { message: String(error) };
}

export function isRetryableGeminiError(error: unknown) {
  const { status, message } = extractErrorDetails(error);
  const lower = message.toLowerCase();

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 404 ||
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('rate-limit') ||
    lower.includes('resource exhausted') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded') ||
    lower.includes('unavailable') ||
    lower.includes('not found') ||
    lower.includes('not supported') ||
    lower.includes('not available')
  );
}

export function geminiUserError(error: unknown) {
  if (error instanceof GeminiFallbackError) {
    const models = error.attempts.map(attempt => attempt.model).join(', ');
    return `Gemini is temporarily unavailable across the configured fallback models (${models}). Please try again shortly or check your Gemini API quota.`;
  }

  return error instanceof Error ? error.message : 'Gemini request failed';
}

export async function generateGeminiContent({
  apiKey,
  body,
  models = GEMINI_MODEL_FALLBACKS,
}: {
  apiKey: string;
  body: unknown;
  models?: readonly string[];
}) {
  const attempts: GeminiAttempt[] = [];

  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok || data.error) {
        const error = {
          status: response.status,
          message: data.error?.message || response.statusText || 'Gemini request failed',
        };
        attempts.push({ model, status: response.status, message: error.message });
        if (isRetryableGeminiError(error)) continue;
        throw new Error(error.message);
      }

      return { data, model };
    } catch (error) {
      const details = extractErrorDetails(error);
      attempts.push({ model, ...details });
      if (isRetryableGeminiError(error)) continue;
      throw error;
    }
  }

  throw new GeminiFallbackError(attempts);
}

export function createGeminiFallbackMiddleware(getModel: (model: string) => LanguageModelV3): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    overrideModelId: () => GEMINI_MODEL_FALLBACKS.join(' -> '),
    wrapGenerate: async ({ doGenerate, params }) => {
      const attempts: GeminiAttempt[] = [];

      for (let index = 0; index < GEMINI_MODEL_FALLBACKS.length; index += 1) {
        const model = GEMINI_MODEL_FALLBACKS[index];

        try {
          return index === 0 ? await doGenerate() : await getModel(model).doGenerate(params);
        } catch (error) {
          const details = extractErrorDetails(error);
          attempts.push({ model, ...details });
          if (isRetryableGeminiError(error)) continue;
          throw error;
        }
      }

      throw new GeminiFallbackError(attempts);
    },
    wrapStream: async ({ doStream, params }) => {
      const attempts: GeminiAttempt[] = [];

      for (let index = 0; index < GEMINI_MODEL_FALLBACKS.length; index += 1) {
        const model = GEMINI_MODEL_FALLBACKS[index];

        try {
          return index === 0 ? await doStream() : await getModel(model).doStream(params);
        } catch (error) {
          const details = extractErrorDetails(error);
          attempts.push({ model, ...details });
          if (isRetryableGeminiError(error)) continue;
          throw error;
        }
      }

      throw new GeminiFallbackError(attempts);
    },
  };
}
