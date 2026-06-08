// Cliente HTTP fino para a API do servidor de tradução.
export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Erro inesperado" }));
    throw new Error(error.error || "Erro inesperado");
  }

  return response.json();
}
