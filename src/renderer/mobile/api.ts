export class MonitorRequestError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(),
      path.startsWith("projects/") ? 120000 : 20000,
    );
  try {
    const response = await fetch(`/api/${path}`, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const data = await response
      .json()
      .catch(() => ({ error: "The Mac returned an unreadable response." }));
    if (!response.ok) {
      if (response.status === 401 && path !== "pair")
        window.dispatchEvent(new Event("monitor-session-expired"));
      throw new MonitorRequestError(
        data.error ?? `Request failed (${response.status})`,
        response.status,
      );
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}
export const safeId = (value: string) => encodeURIComponent(value);
