export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(input, init);
  const rawText = await res.text();
  const trimmed = rawText.trimStart();

  if (!trimmed) {
    throw new Error(`Resposta vazia do servidor (HTTP ${res.status}).`);
  }

  if (trimmed.startsWith('<')) {
    throw new Error(
      `O servidor retornou uma página HTML inesperada em vez de dados JSON (HTTP ${res.status}).`
    );
  }

  try {
    const data = JSON.parse(rawText) as T;
    return { ok: res.ok, status: res.status, data };
  } catch {
    throw new Error(`Resposta inválida do servidor (HTTP ${res.status}).`);
  }
}
