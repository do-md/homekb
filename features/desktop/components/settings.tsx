"use client";
import { useEffect } from "react";
import { useDesktopStore, useDesktopStoreApi } from "../store/desktop-store";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-base-200 flex flex-col gap-3 rounded-xl p-4">
      <h2 className="text-sm font-semibold opacity-70">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="shrink-0 opacity-50">{label}</span>
      <span className="truncate font-mono text-xs" title={value}>
        {value}
      </span>
    </div>
  );
}

/** 桌面专属「设置」视图：引擎/目录信息、OpenAI key、中继与配对、tunnel 开关。 */
export function SettingsView() {
  const api = useDesktopStoreApi();
  const engine = useDesktopStore((s) => s.state.engine);
  const keyDraft = useDesktopStore((s) => s.state.keyDraft);
  const keyBusy = useDesktopStore((s) => s.state.keyBusy);
  const registerDraft = useDesktopStore((s) => s.state.registerDraft);
  const registerBusy = useDesktopStore((s) => s.state.registerBusy);
  const registerError = useDesktopStore((s) => s.state.registerError);
  const pair = useDesktopStore((s) => s.state.pair);
  const pairBusy = useDesktopStore((s) => s.state.pairBusy);
  const pairError = useDesktopStore((s) => s.state.pairError);
  const tunnelRunning = useDesktopStore((s) => s.state.tunnelRunning);
  const tunnelBusy = useDesktopStore((s) => s.state.tunnelBusy);
  const notice = useDesktopStore((s) => s.state.notice);

  useEffect(() => {
    void api.refreshEngine();
  }, [api]);

  return (
    <div className="flex flex-col gap-4">
      <Section title="引擎">
        <Row label="版本" value={engine?.version ?? "未知"} />
        <Row label="二进制" value={engine?.path ?? "未安装"} />
        <Row label="本机服务" value={engine?.serveRunning ? "运行中（127.0.0.1:8765）" : "未运行"} />
      </Section>

      <Section title="数据目录（数据永远在这台电脑上）">
        <Row label="笔记" value={engine?.notesDir ?? "-"} />
        <Row label="数据根" value={engine?.root ?? "-"} />
        <Row label="配置" value={engine?.configPath ?? "-"} />
      </Section>

      <Section title="OpenAI Key（仅存本机 config.toml，编译与问答用）">
        <Row label="当前" value={engine?.openaiKeyPresent ? "已配置" : "未配置"} />
        <div className="flex gap-2">
          <input
            type="password"
            className="input input-sm flex-1"
            placeholder="sk-…"
            value={keyDraft}
            onChange={(e) => api.setKeyDraft(e.target.value)}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={keyBusy || !keyDraft.trim()}
            onClick={() => void api.saveOpenaiKey()}
          >
            {keyBusy ? <span className="loading loading-spinner loading-xs" /> : "保存"}
          </button>
        </div>
      </Section>

      <Section title="远程访问（经中继，中继不存任何知识库数据）">
        {engine?.relay ? (
          <>
            <Row label="中继" value={engine.relay.url} />
            <Row label="设备名" value={engine.relay.name} />
            <div className="flex items-center justify-between text-sm">
              <span className="opacity-50">隧道常驻（手机/远程 MCP 需开启）</span>
              <input
                type="checkbox"
                className="toggle toggle-sm"
                checked={tunnelRunning}
                disabled={tunnelBusy}
                onChange={() => void api.toggleTunnel()}
              />
            </div>
            <div className="divider my-0" />
            <button
              className="btn btn-sm"
              disabled={pairBusy}
              onClick={() => void api.newPairCode()}
            >
              {pairBusy ? <span className="loading loading-spinner loading-xs" /> : "生成配对码"}
            </button>
            {pair && (
              <div className="bg-base-100 flex flex-col items-center gap-1 rounded-lg p-4">
                <div className="font-mono text-3xl font-bold tracking-[0.3em]">{pair.code}</div>
                <div className="text-xs opacity-50">
                  10 分钟内有效 · 手机打开 {pair.relayUrl} 输入，或 Claude 手机端连接器授权页输入
                </div>
              </div>
            )}
            {pairError && <div className="text-error text-xs">{pairError}</div>}
          </>
        ) : (
          <>
            <p className="text-xs opacity-60">
              注册到一台自托管中继后，手机与 Claude 手机端才能远程访问这台电脑。
            </p>
            <div className="flex gap-2">
              <input
                className="input input-sm flex-1"
                placeholder="https://kb.example.com"
                value={registerDraft}
                onChange={(e) => api.setRegisterDraft(e.target.value)}
              />
              <button
                className="btn btn-sm btn-primary"
                disabled={registerBusy || !registerDraft.trim()}
                onClick={() => void api.register()}
              >
                {registerBusy ? <span className="loading loading-spinner loading-xs" /> : "注册"}
              </button>
            </div>
            {registerError && <div className="text-error text-xs">{registerError}</div>}
          </>
        )}
      </Section>

      {notice && (
        <div className="toast toast-center toast-bottom z-20">
          <div className="alert alert-info py-2 text-sm">{notice}</div>
        </div>
      )}
    </div>
  );
}
