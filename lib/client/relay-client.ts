"use client";

/** 浏览器端中继客户端：token 存 localStorage，一切数据经 /api/relay/rpc */

const TOKEN_KEY = "homekb.token.v1";
const HOME_KEY = "homekb.home.v1";

export interface PairedHome {
  homeId: string;
  homeName: string;
}

export class RelayError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getPairedHome(): PairedHome | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(HOME_KEY);
    return raw ? (JSON.parse(raw) as PairedHome) : null;
  } catch {
    return null;
  }
}

export function storePairing(token: string, home: PairedHome) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(HOME_KEY, JSON.stringify(home));
}

export function clearPairing() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(HOME_KEY);
}

export async function claimPairCode(
  code: string,
  label: string,
): Promise<PairedHome> {
  const res = await fetch("/api/relay/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "claim", code, label }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new RelayError(data.error ?? "claim_failed", "配对码无效或已过期");
  }
  const home = { homeId: data.homeId, homeName: data.homeName };
  storePairing(data.token, home);
  return home;
}

export async function rpc<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new RelayError("unauthorized", "未配对");
  const res = await fetch("/api/relay/rpc", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new RelayError("unauthorized", "配对已失效，请重新配对");
  if (!res.ok || !data.ok) {
    const code = data.error ?? `http_${res.status}`;
    const msg =
      code === "home_offline"
        ? "家里电脑不在线（需在电脑上运行 homekb tunnel）"
        : code === "timeout"
          ? "家里电脑响应超时"
          : (data.message ?? data.detail?.message ?? "请求失败");
    throw new RelayError(code, msg);
  }
  return data.result as T;
}

export async function checkHealth(): Promise<boolean> {
  const token = getToken();
  if (!token) throw new RelayError("unauthorized", "未配对");
  const res = await fetch("/api/relay/health", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new RelayError("unauthorized", "配对已失效");
  const data = await res.json();
  return !!data.online;
}
