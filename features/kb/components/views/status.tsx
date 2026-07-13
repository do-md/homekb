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
      ? "Checking…"
      : desktop
        ? online
          ? "Local engine running"
          : "Local engine not responding"
        : online
          ? "Tunnel online"
          : "Tunnel offline (run homekb tunnel on your home machine)";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{homeName || "Home machine"}</div>
          <div className="text-xs opacity-50">{connText}</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => void api.loadStatus()}>
          Refresh
        </button>
      </div>

      {loading && !status ? (
        <div className="py-12 text-center">
          <span className="loading loading-spinner" />
        </div>
      ) : status ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Documents" value={status.docs ?? "-"} />
          <Stat label="Chunks" value={status.chunks ?? "-"} />
          <Stat label="Vectorized" value={status.chunksWithVectors ?? "-"} />
          <Stat label="Pending" value={status.pending ?? "-"} />
          <Stat label="Failures" value={status.failures ?? "-"} />
          <Stat label="Index generation" value={status.generation ?? "-"} />
          <Stat
            label="Last indexed"
            value={
              status.lastCompileAt
                ? new Date(status.lastCompileAt * 1000).toLocaleString()
                : "-"
            }
          />
          <Stat label="Embedding model" value={status.embeddingModel ?? "-"} />
        </div>
      ) : (
        <p className="py-8 text-center text-sm opacity-50">No status data available</p>
      )}

      <div className="flex gap-2">
        <button className="btn btn-sm" onClick={() => void api.reindex()}>
          Reindex now
        </button>
        {!desktop && (
          <button
            className="btn btn-ghost btn-sm text-error ml-auto"
            onClick={() => {
              if (confirm("Unpair from this machine?")) api.unpair();
            }}
          >
            Unpair
          </button>
        )}
      </div>
    </div>
  );
}
