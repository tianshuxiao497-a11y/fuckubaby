"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-page">
      <h1>页面暂时无法运行</h1>
      <p>没有任何真实交易受到影响。请重试。</p>
      <button onClick={reset} type="button">重新加载</button>
    </main>
  );
}
