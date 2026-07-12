"use client";
import { useKbStore, useKbStoreApi } from "../../store/kb-store";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-base-200 rounded-lg p-3">
      <div className="text-xs opacity-50">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold">{value}</div>
    </div>
  );
}

export function StatusView() {
  const api = useKbStoreApi();
  const status = useKbStore((s) => s.state.status);
  const loading = useKbStore((s) => s.state.statusLoading);
  const homeName = useKbStore((s) => s.state.homeName);
  const online = useKbStore((s) => s.state.online);
  const desktop = useKbStore((s) => s.state.desktop);

  const connText =
    online === null
      ? "探测中…"
      : desktop
        ? online
          ? "本机引擎运行中"
          : "本机引擎未响应"
        : online
          ? "隧道在线"
          : "隧道离线（家中运行 homekb tunnel）";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{homeName || "家里电脑"}</div>
          <div className="text-xs opacity-50">{connText}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void api.loadStatus()}>
          刷新
        </button>
      </div>

      {loading && !status ? (
        <div className="py-12 text-center">
          <span className="loading loading-spinner" />
        </div>
      ) : status ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="文档" value={status.docs ?? "-"} />
          <Stat label="分块" value={status.chunks ?? "-"} />
          <Stat label="已向量化" value={status.chunksWithVectors ?? "-"} />
          <Stat label="待编译" value={status.pending ?? "-"} />
          <Stat label="失败" value={status.failures ?? "-"} />
          <Stat label="索引代数" value={status.generation ?? "-"} />
          <Stat
            label="上次编译"
            value={
              status.lastCompileAt
                ? new Date(status.lastCompileAt * 1000).toLocaleString()
                : "-"
            }
          />
          <Stat label="Embedding" value={status.embeddingModel ?? "-"} />
        </div>
      ) : (
        <p className="py-8 text-center text-sm opacity-50">暂无状态数据</p>
      )}

      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => void api.reindex()}>
          立即编译
        </button>
        {!desktop && (
          <button
            className="btn btn-ghost btn-sm text-error ml-auto"
            onClick={() => {
              if (confirm("解除与这台电脑的配对？")) api.unpair();
            }}
          >
            解除配对
          </button>
        )}
      </div>
    </div>
  );
}
