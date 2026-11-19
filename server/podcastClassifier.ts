import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { MediaItem } from '../src/types/media.ts';

export interface VideoMetadataInput {
  id: string;
  title: string;
  rawTitle?: string;
  category?: string;
  folderPath?: string;
  duration?: string;
  quality?: string;
  format?: string;
  description?: string;
  url?: string;
}

export interface VideoPodcastClassification {
  id: string;
  is_podcast: boolean;
}

const MODEL_NAME = 'gemini-4-hydrogen';
const BATCH_SIZE = 25;
const MAX_CACHE_ENTRIES = 5000;

const SYSTEM_INSTRUCTION = [
  'Analise os metadados deste vídeo.',
  'Retorne is_podcast: true se o vídeo for uma conversa longa em estúdio, entrevista, mesa redonda ou corte de podcast.',
  'Retorne is_podcast: false para qualquer outro formato (ação, vlog, tutorial, clipe musical, cena dinâmica).',
].join(' ');

// In-memory cache keyed by normalized URL/ID + title so repeated pages/scans avoid duplicate calls
const classificationCache = new Map<string, boolean>();

function buildCacheKey(item: VideoMetadataInput): string {
  const base = (item.url || item.id || '').trim().toLowerCase();
  const title = (item.title || item.rawTitle || '').trim().toLowerCase();
  return `${base}::${title}`;
}

function setCachedResult(key: string, value: boolean) {
  if (classificationCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = classificationCache.keys().next().value;
    if (oldestKey !== undefined) {
      classificationCache.delete(oldestKey);
    }
  }
  classificationCache.set(key, value);
}

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'Chave GEMINI_API_KEY não configurada no servidor. Configure sua chave no painel Settings > Secrets para classificar os vídeos.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function formatGeminiError(err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;

  if (
    status === 400 &&
    /API_KEY_INVALID|API key not valid/i.test(rawMessage)
  ) {
    return new Error(
      'Chave da API Gemini inválida (API_KEY_INVALID). Verifique a chave configurada em Settings > Secrets.'
    );
  }
  if (status === 403 || /PERMISSION_DENIED/i.test(rawMessage)) {
    return new Error(
      'Permissão negada na API Gemini (PERMISSION_DENIED). Verifique sua chave em Settings > Secrets.'
    );
  }
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(rawMessage)) {
    return new Error(
      'Limite de requisições da API Gemini atingido (RESOURCE_EXHAUSTED). Tente novamente em alguns instantes.'
    );
  }
  if (status === 404 || /NOT_FOUND/i.test(rawMessage)) {
    return new Error(
      `Modelo Gemini indisponível ou não encontrado (${MODEL_NAME}).`
    );
  }
  return err instanceof Error ? err : new Error(rawMessage);
}

function isRetryableError(err: unknown): boolean {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : undefined;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    return false;
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|timeout|ECONNRESET|ETIMEDOUT|503|502|429/i.test(msg);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Operação cancelada.');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operação cancelada.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function callGeminiBatch(
  ai: GoogleGenAI,
  batch: VideoMetadataInput[],
  signal?: AbortSignal
): Promise<Map<string, boolean>> {
  const metadataPayload = batch.map((item) => ({
    id: item.id,
    title: item.title,
    ...(item.rawTitle && item.rawTitle !== item.title ? { rawTitle: item.rawTitle } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.duration ? { duration: item.duration } : {}),
    ...(item.description ? { description: item.description.slice(0, 320) } : {}),
    ...(item.folderPath ? { folderPath: item.folderPath } : {}),
    ...(item.format ? { format: item.format } : {}),
  }));

  const prompt = [
    'Analise os metadados de cada vídeo abaixo e retorne um array JSON com o resultado para cada item.',
    'Critério obrigatório:',
    '- is_podcast: true se o vídeo for uma conversa longa em estúdio, entrevista, mesa redonda ou corte de podcast.',
    '- is_podcast: false para qualquer outro formato (ação, vlog, tutorial, clipe musical, cena dinâmica).',
    '',
    'Vídeos:',
    JSON.stringify(metadataPayload),
  ].join('\n');

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) {
      throw new Error('Operação cancelada.');
    }
    try {
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt,
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: {
                  type: Type.STRING,
                  description: 'O mesmo id do vídeo fornecido na entrada.',
                },
                is_podcast: {
                  type: Type.BOOLEAN,
                  description:
                    'true se o vídeo for uma conversa longa em estúdio, entrevista, mesa redonda ou corte de podcast; false para qualquer outro formato.',
                },
              },
              required: ['id', 'is_podcast'],
            },
          },
        },
      });

      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        throw new Error('Resposta vazia recebida da API Gemini ao classificar vídeos.');
      }

      const parsed = JSON.parse(rawText) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error('Formato JSON inesperado retornado pela API Gemini.');
      }

      const resultMap = new Map<string, boolean>();
      for (const entry of parsed) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          'is_podcast' in entry &&
          typeof (entry as { id: unknown }).id === 'string' &&
          typeof (entry as { is_podcast: unknown }).is_podcast === 'boolean'
        ) {
          resultMap.set(
            (entry as { id: string }).id,
            (entry as { is_podcast: boolean }).is_podcast
          );
        }
      }

      // Verify every item in batch received a classification
      const missingIds = batch
        .map((b) => b.id)
        .filter((id) => !resultMap.has(id));
      if (missingIds.length > 0) {
        throw new Error(
          `A API Gemini não retornou a classificação de ${missingIds.length} vídeo(s).`
        );
      }

      return resultMap;
    } catch (err) {
      lastError = err;
      if (attempt < 2 && isRetryableError(err)) {
        await sleep(600 * Math.pow(2, attempt), signal);
        continue;
      }
      throw formatGeminiError(err);
    }
  }

  throw formatGeminiError(lastError);
}

/**
 * Classifies a list of video metadata objects via Gemini (`is_podcast: boolean`).
 * Uses an in-memory cache for previously seen videos and batches remaining items.
 */
export async function classifyVideoMetadataList(
  items: VideoMetadataInput[],
  signal?: AbortSignal
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  if (items.length === 0) return results;

  const pending: VideoMetadataInput[] = [];
  for (const item of items) {
    const cacheKey = buildCacheKey(item);
    if (classificationCache.has(cacheKey)) {
      results.set(item.id, classificationCache.get(cacheKey)!);
    } else {
      pending.push(item);
    }
  }

  if (pending.length === 0) {
    return results;
  }

  const ai = getGenAIClient();

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    if (signal?.aborted) {
      throw new Error('Classificação cancelada.');
    }
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const chunkMap = await callGeminiBatch(ai, chunk, signal);
    for (const item of chunk) {
      const value = chunkMap.get(item.id);
      if (typeof value === 'boolean') {
        results.set(item.id, value);
        setCachedResult(buildCacheKey(item), value);
      }
    }
  }

  return results;
}

/**
 * Enriches MediaItem objects with `is_podcast` classification from Gemini.
 */
export async function classifyMediaItems(
  items: MediaItem[],
  signal?: AbortSignal
): Promise<MediaItem[]> {
  if (items.length === 0) return items;

  const needsClassification = items.filter((item) => typeof item.is_podcast !== 'boolean');
  if (needsClassification.length === 0) return items;

  const map = await classifyVideoMetadataList(
    needsClassification.map((item) => ({
      id: item.id,
      title: item.title,
      rawTitle: item.rawTitle,
      category: item.category,
      folderPath: item.folderPath,
      duration: item.duration,
      quality: item.quality,
      format: item.format,
      description: item.description,
      url: item.url,
    })),
    signal
  );

  return items.map((item) => {
    if (typeof item.is_podcast === 'boolean') return item;
    const isPodcast = map.get(item.id);
    return typeof isPodcast === 'boolean' ? { ...item, is_podcast: isPodcast } : item;
  });
}
