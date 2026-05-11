const DEFAULT_API_BASE_URL = "http://127.0.0.1:3001";

export function getApiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  const payload = (await response.json()) as T;

  if (!response.ok) {
    throw new Error("Request failed");
  }

  return payload;
}

