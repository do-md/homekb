"use client";
import { useState } from "react";
import { useKbStore, useKbStoreApi } from "../store/kb-store";

export function PairScreen() {
  const api = useKbStoreApi();
  const busy = useKbStore((s) => s.state.pairBusy);
  const error = useKbStore((s) => s.state.pairError);
  const [code, setCode] = useState("");

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-3xl font-bold">HomeKB</h1>
        <p className="mt-2 text-center text-sm opacity-60">
          你的知识库在你自己的电脑上。
          <br />
          在家里电脑运行 <code>homekb pair</code> 获取配对码。
        </p>
        <form
          className="mt-6 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) void api.pair(code.trim());
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="配对码，如 A7KM2XQ9"
            maxLength={8}
            autoFocus
            className="input input-bordered input-lg w-full text-center font-mono uppercase tracking-widest"
            autoComplete="one-time-code"
          />
          {error && <p className="text-error text-center text-sm">{error}</p>}
          <button
            type="submit"
            disabled={busy || code.trim().length < 4}
            className="btn btn-primary btn-lg w-full"
          >
            {busy ? <span className="loading loading-spinner" /> : "配对"}
          </button>
        </form>
        <p className="mt-6 text-center text-xs opacity-40">
          本服务器只做转发与配对，不存储任何知识库内容。
        </p>
      </div>
    </main>
  );
}
