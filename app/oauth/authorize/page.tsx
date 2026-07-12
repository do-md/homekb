import { relayDb } from "@/lib/relay/db";

export const dynamic = "force-dynamic";

/**
 * OAuth 授权页 = 输入配对码（无账号体系）。
 * MCP 客户端（Claude 手机端等）跳到这里，用户输入家里生成的配对码即完成授权。
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const get = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const error = get("error");

  const client = clientId
    ? (relayDb()
        .prepare("SELECT client_id, redirect_uris, name FROM oauth_clients WHERE client_id = ?")
        .get(clientId) as { client_id: string; redirect_uris: string; name: string } | undefined)
    : undefined;

  const redirectOk =
    !!client && (JSON.parse(client.redirect_uris) as string[]).includes(redirectUri);

  const invalid = !client
    ? "未知的客户端（client_id 无效）"
    : !redirectOk
      ? "回调地址与注册信息不符"
      : get("response_type") !== "code"
        ? "不支持的 response_type"
        : null;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="card bg-base-200 w-full max-w-sm shadow-xl">
        <div className="card-body">
          <h1 className="card-title">HomeKB 授权</h1>
          {invalid ? (
            <p className="text-error">{invalid}</p>
          ) : (
            <>
              <p className="text-sm opacity-70">
                <span className="font-semibold">{client!.name || "一个 MCP 客户端"}</span>{" "}
                请求访问你家里电脑上的知识库。请输入配对码（在家里电脑上运行{" "}
                <code className="text-xs">homekb pair</code> 获取）。
              </p>
              {error === "bad_code" && (
                <p className="text-error text-sm">配对码无效或已过期，请重新生成。</p>
              )}
              <form method="POST" action="/api/oauth/authorize" className="mt-2 flex flex-col gap-3">
                <input type="hidden" name="client_id" value={clientId} />
                <input type="hidden" name="redirect_uri" value={redirectUri} />
                <input type="hidden" name="state" value={get("state")} />
                <input type="hidden" name="code_challenge" value={get("code_challenge")} />
                <input type="hidden" name="code_challenge_method" value={get("code_challenge_method")} />
                <input type="hidden" name="scope" value={get("scope")} />
                <input type="hidden" name="response_type" value={get("response_type")} />
                <input
                  name="pair_code"
                  required
                  autoFocus
                  placeholder="配对码，如 A7KM2XQ9"
                  className="input input-bordered w-full text-center font-mono text-lg uppercase tracking-widest"
                  autoComplete="one-time-code"
                  maxLength={8}
                />
                <button type="submit" className="btn btn-primary w-full">
                  授权访问
                </button>
              </form>
              <p className="mt-2 text-xs opacity-50">
                你的数据始终在你自己的电脑上；本服务器只做转发，不存储任何知识库内容。
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
