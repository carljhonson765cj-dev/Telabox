export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: T }> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const resposta = await fetch(input, {
    ...init,
    headers,
  });

  // 1. Verifica o cabeçalho Content-Type antes de tentar converter para JSON
  const tipoConteudo = (resposta.headers.get('content-type') || '').toLowerCase();
  if (!tipoConteudo.includes('application/json')) {
    const textoRecebido = await resposta.text();
    console.warn('Resposta inesperada (não é JSON):', textoRecebido.slice(0, 150));
    if (!resposta.ok) {
      throw new Error(`Erro HTTP: ${resposta.status}`);
    }
    throw new Error('O servidor retornou HTML/Texto em vez de JSON.');
  }

  // 2. Converte os dados JSON com segurança
  let data: T;
  try {
    data = (await resposta.json()) as T;
  } catch {
    if (!resposta.ok) {
      throw new Error(`Erro HTTP: ${resposta.status}`);
    }
    throw new Error(`Resposta JSON inválida do servidor (HTTP ${resposta.status}).`);
  }

  // 3. Verifica se a resposta da rede foi bem-sucedida
  if (!resposta.ok) {
    const serverMsg =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : '';
    throw new Error(serverMsg || `Erro HTTP: ${resposta.status}`);
  }

  return { ok: resposta.ok, status: resposta.status, data };
}
