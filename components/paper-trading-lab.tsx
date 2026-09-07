"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SymbolName = "BTCUSDT" | "ETHUSDT" | "SOLUSDT";
type IntervalName = "1m" | "5m" | "15m" | "1h";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type BotConfig = {
  symbol: SymbolName;
  interval: IntervalName;
  fastPeriod: number;
  slowPeriod: number;
  tradeSize: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  pollSeconds: number;
};

type Position = {
  quantity: number;
  entryPrice: number;
  openedAt: string;
};

type Trade = {
  id: string;
  time: string;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  value: number;
  fee: number;
  reason: string;
  realizedPnl?: number;
};

type PaperAccount = {
  cash: number;
  startingCash: number;
  position: Position | null;
  trades: Trade[];
};

type MarketResponse = {
  candles: Candle[];
  source: string;
  fetchedAt: string;
  marketNotice?: string;
  error?: string;
};

const storageKey = "binance-testnet-quant-lab-v1";
const feeRate = 0.001;

const defaultConfig: BotConfig = {
  symbol: "BTCUSDT",
  interval: "5m",
  fastPeriod: 9,
  slowPeriod: 21,
  tradeSize: 1000,
  stopLossPercent: 1.5,
  takeProfitPercent: 3,
  pollSeconds: 60
};

const createAccount = (startingCash = 10_000): PaperAccount => ({
  cash: startingCash,
  startingCash,
  position: null,
  trades: []
});

const defaultAccount = createAccount();

function numberOr(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampConfig(value: BotConfig): BotConfig {
  const fastPeriod = Math.max(3, Math.min(Math.round(numberOr(value.fastPeriod, 9)), 50));
  const slowPeriod = Math.max(
    fastPeriod + 2,
    Math.min(Math.round(numberOr(value.slowPeriod, 21)), 100)
  );

  return {
    symbol: ["BTCUSDT", "ETHUSDT", "SOLUSDT"].includes(value.symbol)
      ? value.symbol
      : "BTCUSDT",
    interval: ["1m", "5m", "15m", "1h"].includes(value.interval)
      ? value.interval
      : "5m",
    fastPeriod,
    slowPeriod,
    tradeSize: Math.max(25, Math.min(numberOr(value.tradeSize, 1000), 10_000)),
    stopLossPercent: Math.max(0.1, Math.min(numberOr(value.stopLossPercent, 1.5), 20)),
    takeProfitPercent: Math.max(0.1, Math.min(numberOr(value.takeProfitPercent, 3), 50)),
    pollSeconds: [60, 120, 300].includes(numberOr(value.pollSeconds, 60))
      ? numberOr(value.pollSeconds, 60)
      : 60
  };
}

function generateDemoCandles(symbol: SymbolName): Candle[] {
  const base = symbol === "BTCUSDT" ? 68_000 : symbol === "ETHUSDT" ? 3_600 : 145;
  const now = Date.now() - 120 * 5 * 60_000;
  let previous = base * 0.965;

  return Array.from({ length: 120 }, (_, index) => {
    const wave = Math.sin(index / 5.4) * 0.006 + Math.cos(index / 12.5) * 0.009;
    const trend = index < 52 ? index * 0.00034 : (104 - index) * 0.00022;
    const close = base * (1 + wave + trend);
    const open = previous;
    const high = Math.max(open, close) * 1.0025;
    const low = Math.min(open, close) * 0.9975;
    previous = close;
    return { time: now + index * 5 * 60_000, open, high, low, close };
  });
}

function simpleMovingAverage(candles: Candle[], period: number, end = candles.length) {
  if (end < period) {
    return null;
  }

  const start = end - period;
  const total = candles.slice(start, end).reduce((sum, candle) => sum + candle.close, 0);
  return total / period;
}

function formatNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

function money(value: number) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPrice(value: number) {
  return value >= 1_000 ? formatNumber(value, 2) : formatNumber(value, 4);
}

function formatTime(value: string | number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function calculateEquity(account: PaperAccount, lastPrice: number) {
  return account.cash + (account.position?.quantity ?? 0) * lastPrice;
}

function createTradeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function executeBuy(
  account: PaperAccount,
  price: number,
  config: BotConfig,
  reason: string,
  timestamp: string
) {
  if (account.position) {
    return { account, action: "已有持仓，本次不重复买入。" };
  }

  const tradeValue = Math.min(config.tradeSize, account.cash / (1 + feeRate));
  if (tradeValue < 25) {
    return { account, action: "可用虚拟资金不足，跳过买入。" };
  }

  const quantity = tradeValue / price;
  const fee = tradeValue * feeRate;
  const trade: Trade = {
    id: createTradeId(),
    time: timestamp,
    side: "BUY",
    price,
    quantity,
    value: tradeValue,
    fee,
    reason
  };

  return {
    account: {
      ...account,
      cash: account.cash - tradeValue - fee,
      position: { quantity, entryPrice: price, openedAt: timestamp },
      trades: [trade, ...account.trades].slice(0, 60)
    },
    action: `模拟买入 ${formatNumber(quantity, 6)} ${config.symbol.replace("USDT", "")}。`
  };
}

function executeSell(
  account: PaperAccount,
  price: number,
  config: BotConfig,
  reason: string,
  timestamp: string
) {
  const position = account.position;
  if (!position) {
    return { account, action: "当前没有持仓，跳过卖出。" };
  }

  const value = position.quantity * price;
  const fee = value * feeRate;
  const cost = position.quantity * position.entryPrice;
  const entryFee = cost * feeRate;
  const realizedPnl = value - fee - cost - entryFee;
  const trade: Trade = {
    id: createTradeId(),
    time: timestamp,
    side: "SELL",
    price,
    quantity: position.quantity,
    value,
    fee,
    reason,
    realizedPnl
  };

  return {
    account: {
      ...account,
      cash: account.cash + value - fee,
      position: null,
      trades: [trade, ...account.trades].slice(0, 60)
    },
    action: `模拟卖出 ${formatNumber(position.quantity, 6)} ${config.symbol.replace("USDT", "")}。`
  };
}

function runStrategy(account: PaperAccount, candles: Candle[], config: BotConfig) {
  const current = candles.at(-1);
  if (!current || candles.length < config.slowPeriod + 2) {
    return { account, action: "K 线数量不足，等待更多数据。" };
  }

  const price = current.close;
  const fast = simpleMovingAverage(candles, config.fastPeriod);
  const slow = simpleMovingAverage(candles, config.slowPeriod);
  const previousFast = simpleMovingAverage(candles, config.fastPeriod, candles.length - 1);
  const previousSlow = simpleMovingAverage(candles, config.slowPeriod, candles.length - 1);

  if (!fast || !slow || !previousFast || !previousSlow) {
    return { account, action: "均线尚未就绪。" };
  }

  const timestamp = new Date(current.time).toISOString();
  if (account.position) {
    const changePercent = ((price - account.position.entryPrice) / account.position.entryPrice) * 100;
    if (changePercent <= -config.stopLossPercent) {
      return executeSell(account, price, config, `止损 ${formatNumber(changePercent)}%`, timestamp);
    }
    if (changePercent >= config.takeProfitPercent) {
      return executeSell(account, price, config, `止盈 +${formatNumber(changePercent)}%`, timestamp);
    }
    if (previousFast >= previousSlow && fast < slow) {
      return executeSell(account, price, config, "短均线下穿长均线", timestamp);
    }
    return { account, action: "持仓中：没有满足卖出条件。" };
  }

  if (previousFast <= previousSlow && fast > slow) {
    return executeBuy(account, price, config, "短均线上穿长均线", timestamp);
  }

  return { account, action: "空仓：没有满足买入条件。" };
}

function loadLocalState() {
  if (typeof window === "undefined") {
    return { config: defaultConfig, account: defaultAccount, candles: generateDemoCandles("BTCUSDT") };
  }

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) {
      return { config: defaultConfig, account: defaultAccount, candles: generateDemoCandles("BTCUSDT") };
    }
    const parsed = JSON.parse(saved) as {
      config?: BotConfig;
      account?: PaperAccount;
      candles?: Candle[];
    };
    return {
      config: clampConfig({ ...defaultConfig, ...parsed.config }),
      account: parsed.account && Number.isFinite(parsed.account.cash) ? parsed.account : defaultAccount,
      candles: Array.isArray(parsed.candles) && parsed.candles.length > 0 ? parsed.candles : generateDemoCandles("BTCUSDT")
    };
  } catch {
    return { config: defaultConfig, account: defaultAccount, candles: generateDemoCandles("BTCUSDT") };
  }
}

export function PaperTradingLab() {
  const [hydrated, setHydrated] = useState(false);
  const [config, setConfig] = useState<BotConfig>(defaultConfig);
  const [account, setAccount] = useState<PaperAccount>(defaultAccount);
  const [candles, setCandles] = useState<Candle[]>(() => generateDemoCandles("BTCUSDT"));
  const [marketSource, setMarketSource] = useState("内置演示行情");
  const [marketUpdatedAt, setMarketUpdatedAt] = useState("");
  const [status, setStatus] = useState("尚未运行策略。当前是离线演示行情。");
  const [running, setRunning] = useState(false);
  const [fetching, setFetching] = useState(false);

  const currentPrice = candles.at(-1)?.close ?? 0;
  const fastAverage = useMemo(
    () => simpleMovingAverage(candles, config.fastPeriod),
    [candles, config.fastPeriod]
  );
  const slowAverage = useMemo(
    () => simpleMovingAverage(candles, config.slowPeriod),
    [candles, config.slowPeriod]
  );
  const equity = calculateEquity(account, currentPrice);
  const returnPercent = account.startingCash
    ? ((equity - account.startingCash) / account.startingCash) * 100
    : 0;
  const unrealizedPnl = account.position
    ? (currentPrice - account.position.entryPrice) * account.position.quantity
    : 0;

  useEffect(() => {
    const local = loadLocalState();
    setConfig(local.config);
    setAccount(local.account);
    setCandles(local.candles);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify({ config, account, candles }));
  }, [account, candles, config, hydrated]);

  const requestMarketData = useCallback(async () => {
    const response = await fetch(
      `/api/market?symbol=${encodeURIComponent(config.symbol)}&interval=${encodeURIComponent(config.interval)}`,
      { cache: "no-store" }
    );
    const payload = (await response.json()) as MarketResponse;
    if (!response.ok || !Array.isArray(payload.candles)) {
      throw new Error(payload.error || "无法读取 Testnet 行情。");
    }
    return payload;
  }, [config.interval, config.symbol]);

  const refreshPrice = useCallback(async () => {
    setFetching(true);
    try {
      const market = await requestMarketData();
      setCandles(market.candles);
      setMarketSource(market.source);
      setMarketUpdatedAt(market.fetchedAt);
      setStatus(market.marketNotice ?? "Testnet 行情已刷新；未产生任何订单。");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "行情刷新失败。");
    } finally {
      setFetching(false);
    }
  }, [requestMarketData]);

  const runCycle = useCallback(async () => {
    setFetching(true);
    try {
      const market = await requestMarketData();
      const result = runStrategy(account, market.candles, config);
      setCandles(market.candles);
      setMarketSource(market.source);
      setMarketUpdatedAt(market.fetchedAt);
      setAccount(result.account);
      setStatus(`${market.marketNotice ? `${market.marketNotice} ` : ""}策略已检查：${result.action}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "策略运行失败。");
    } finally {
      setFetching(false);
    }
  }, [account, config, requestMarketData]);

  useEffect(() => {
    if (!running) {
      return;
    }
    void runCycle();
    const timer = window.setInterval(() => void runCycle(), config.pollSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [config.pollSeconds, runCycle, running]);

  function updateConfig<K extends keyof BotConfig>(key: K, value: BotConfig[K]) {
    setConfig((current) => clampConfig({ ...current, [key]: value }));
  }

  function loadDemo() {
    setRunning(false);
    setCandles(generateDemoCandles(config.symbol));
    setAccount(createAccount());
    setMarketSource("内置演示行情");
    setMarketUpdatedAt(new Date().toISOString());
    setStatus("已恢复演示行情和 10,000 USDT 虚拟资金。");
  }

  function resetAccount() {
    setRunning(false);
    setAccount(createAccount());
    setStatus("虚拟账户已重置；没有影响任何 Binance 资产。 ");
  }

  function exportReport() {
    const payload = {
      mode: "PAPER_ONLY",
      exportedAt: new Date().toISOString(),
      config,
      account,
      lastPrice: currentPrice,
      equity,
      marketSource,
      marketUpdatedAt
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `paper-report-${config.symbol.toLowerCase()}-${Date.now()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const trendIsPositive = fastAverage !== null && slowAverage !== null && fastAverage > slowAverage;

  return (
    <main className="quant-shell">
      <header className="quant-header">
        <div className="brand-group">
          <div className="brand-symbol" aria-hidden="true">Q</div>
          <div>
            <p className="eyebrow">BINANCE SPOT TESTNET · PAPER ONLY</p>
            <h1>Quant Lab</h1>
            <p className="subhead">均线策略实验台 · 不会发送任何真实订单</p>
          </div>
        </div>
        <div className="header-actions">
          <span className="safe-badge">虚拟仓保护已开启</span>
          <button className="button subtle" onClick={exportReport} type="button">导出报告</button>
          <button className="button subtle" onClick={loadDemo} type="button">恢复演示</button>
        </div>
      </header>

      <section className="safety-banner" aria-label="Paper-only safety notice">
        <span className="safety-icon" aria-hidden="true">✓</span>
        <div>
          <strong>只使用虚拟资金</strong>
          <p>本应用只读取 Binance Spot Testnet 的公开行情；虚拟余额、持仓和订单全部保存在这台设备上，代码没有真实下单接口。</p>
        </div>
      </section>

      <section className="stats-grid" aria-label="Paper account overview">
        <article>
          <span>账户权益</span>
          <strong>{money(equity)}</strong>
          <small>起始虚拟资金 {money(account.startingCash)}</small>
        </article>
        <article>
          <span>可用 USDT</span>
          <strong>{money(account.cash)}</strong>
          <small>不包含任何真实 Binance 余额</small>
        </article>
        <article>
          <span>本轮收益</span>
          <strong className={returnPercent >= 0 ? "positive" : "negative"}>{returnPercent >= 0 ? "+" : ""}{formatNumber(returnPercent)}%</strong>
          <small>{account.position ? `浮动 ${money(unrealizedPnl)}` : "当前空仓"}</small>
        </article>
        <article>
          <span>最新价格</span>
          <strong>{currentPrice ? `$${formatPrice(currentPrice)}` : "--"}</strong>
          <small>{marketSource} {marketUpdatedAt ? `· ${formatTime(marketUpdatedAt)}` : ""}</small>
        </article>
      </section>

      <section className="quant-grid">
        <aside className="control-panel">
          <div className="section-heading">
            <div>
              <p className="label-kicker">STRATEGY</p>
              <h2>策略设置</h2>
            </div>
            <span className={running ? "run-state live" : "run-state"}>{running ? "运行中" : "已暂停"}</span>
          </div>

          <div className="field-stack">
            <div className="field-row two">
              <label>
                交易对
                <select value={config.symbol} onChange={(event) => updateConfig("symbol", event.target.value as SymbolName)}>
                  <option value="BTCUSDT">BTC / USDT</option>
                  <option value="ETHUSDT">ETH / USDT</option>
                  <option value="SOLUSDT">SOL / USDT</option>
                </select>
              </label>
              <label>
                K 线周期
                <select value={config.interval} onChange={(event) => updateConfig("interval", event.target.value as IntervalName)}>
                  <option value="1m">1 分钟</option>
                  <option value="5m">5 分钟</option>
                  <option value="15m">15 分钟</option>
                  <option value="1h">1 小时</option>
                </select>
              </label>
            </div>

            <div className="field-row two">
              <label>
                快速均线
                <input min="3" max="50" type="number" value={config.fastPeriod} onChange={(event) => updateConfig("fastPeriod", numberOr(event.target.value, 9))} />
              </label>
              <label>
                慢速均线
                <input min="5" max="100" type="number" value={config.slowPeriod} onChange={(event) => updateConfig("slowPeriod", numberOr(event.target.value, 21))} />
              </label>
            </div>

            <label>
              单笔虚拟资金（USDT）
              <input min="25" max="10000" step="25" type="number" value={config.tradeSize} onChange={(event) => updateConfig("tradeSize", numberOr(event.target.value, 1000))} />
            </label>

            <div className="field-row two">
              <label>
                止损（%）
                <input min="0.1" max="20" step="0.1" type="number" value={config.stopLossPercent} onChange={(event) => updateConfig("stopLossPercent", numberOr(event.target.value, 1.5))} />
              </label>
              <label>
                止盈（%）
                <input min="0.1" max="50" step="0.1" type="number" value={config.takeProfitPercent} onChange={(event) => updateConfig("takeProfitPercent", numberOr(event.target.value, 3))} />
              </label>
            </div>

            <label>
              自动检查频率
              <select value={config.pollSeconds} onChange={(event) => updateConfig("pollSeconds", numberOr(event.target.value, 60))}>
                <option value="60">每 60 秒</option>
                <option value="120">每 2 分钟</option>
                <option value="300">每 5 分钟</option>
              </select>
            </label>
          </div>

          <div className="strategy-card">
            <strong>SMA 交叉逻辑</strong>
            <p>快线向上穿越慢线时模拟买入；向下穿越时模拟卖出。持仓也会按止损或止盈退出。</p>
            <div className="strategy-rows">
              <span>快线 {fastAverage ? `$${formatPrice(fastAverage)}` : "计算中"}</span>
              <span>慢线 {slowAverage ? `$${formatPrice(slowAverage)}` : "计算中"}</span>
            </div>
            <span className={trendIsPositive ? "trend up" : "trend down"}>{trendIsPositive ? "趋势：快线在上" : "趋势：快线在下"}</span>
          </div>

          <div className="control-actions">
            <button className="button primary" disabled={fetching} onClick={() => void runCycle()} type="button">{fetching ? "正在分析…" : "运行一次"}</button>
            <button className="button subtle" disabled={fetching} onClick={() => void refreshPrice()} type="button">刷新行情</button>
            <button className={running ? "button warning" : "button start"} onClick={() => setRunning((current) => !current)} type="button">{running ? "停止自动策略" : "启动自动策略"}</button>
          </div>
          <p className="status-line">{status}</p>
        </aside>

        <section className="workspace-panel">
          <div className="section-heading market-title">
            <div>
              <p className="label-kicker">MARKET & POSITION</p>
              <h2>{config.symbol.replace("USDT", "/USDT")}</h2>
            </div>
            <span className="market-dot"><i />{marketSource}</span>
          </div>

          <div className="chart-card" aria-label="Recent close-price chart">
            <div className="chart-meta"><span>最近 {candles.length} 根 K 线收盘价</span><strong>{currentPrice ? `$${formatPrice(currentPrice)}` : "--"}</strong></div>
            <MiniChart candles={candles} fastPeriod={config.fastPeriod} slowPeriod={config.slowPeriod} />
            <div className="chart-key"><span><i className="price-line" />收盘价</span><span><i className="fast-line" />SMA {config.fastPeriod}</span><span><i className="slow-line" />SMA {config.slowPeriod}</span></div>
          </div>

          <div className="position-card">
            <div>
              <p className="label-kicker">VIRTUAL POSITION</p>
              <h3>{account.position ? `${config.symbol.replace("USDT", "")} 持仓` : "当前空仓"}</h3>
            </div>
            {account.position ? (
              <div className="position-details">
                <span>数量 <strong>{formatNumber(account.position.quantity, 6)}</strong></span>
                <span>均价 <strong>${formatPrice(account.position.entryPrice)}</strong></span>
                <span>浮动盈亏 <strong className={unrealizedPnl >= 0 ? "positive" : "negative"}>{money(unrealizedPnl)}</strong></span>
              </div>
            ) : <p>等待均线交叉信号；不会触及真实账户。</p>}
          </div>

          <div className="trade-log">
            <div className="section-heading"><div><p className="label-kicker">PAPER TRADE LOG</p><h2>虚拟订单</h2></div><button className="text-button" onClick={resetAccount} type="button">重置虚拟账户</button></div>
            {account.trades.length === 0 ? <div className="empty-state">尚无虚拟订单。点击“运行一次”或启动自动策略来测试。</div> : (
              <div className="trade-table" role="table" aria-label="Virtual trade log">
                <div className="trade-head" role="row"><span>时间</span><span>方向</span><span>价格</span><span>数量</span><span>原因</span><span>已实现盈亏</span></div>
                {account.trades.map((trade) => <div className="trade-row" role="row" key={trade.id}><span>{formatTime(trade.time)}</span><span className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side === "BUY" ? "买入" : "卖出"}</span><span>${formatPrice(trade.price)}</span><span>{formatNumber(trade.quantity, 6)}</span><span>{trade.reason}</span><span className={trade.realizedPnl === undefined ? "" : trade.realizedPnl >= 0 ? "positive" : "negative"}>{trade.realizedPnl === undefined ? "--" : money(trade.realizedPnl)}</span></div>)}
              </div>
            )}
          </div>
        </section>
      </section>

      <footer className="quant-footer">行情来源：Binance Spot Testnet 公开 API。Testnet 会定期重置虚拟数据；本地模拟记录不会自动同步到 Binance。</footer>
    </main>
  );
}

function MiniChart({ candles, fastPeriod, slowPeriod }: { candles: Candle[]; fastPeriod: number; slowPeriod: number }) {
  const visible = candles.slice(-60);
  const priceValues = visible.flatMap((_, index) => {
    const candleIndex = candles.length - visible.length + index + 1;
    return [
      visible[index].close,
      simpleMovingAverage(candles, fastPeriod, candleIndex),
      simpleMovingAverage(candles, slowPeriod, candleIndex)
    ].filter((value): value is number => value !== null);
  });
  const min = Math.min(...priceValues);
  const max = Math.max(...priceValues);
  const range = Math.max(max - min, max * 0.002);
  const makePath = (values: Array<number | null>) => values.map((value, index) => {
    if (value === null) return "";
    const x = (index / Math.max(values.length - 1, 1)) * 100;
    const y = 92 - ((value - min) / range) * 84;
    return `${index === 0 || values[index - 1] === null ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const closePath = makePath(visible.map((candle) => candle.close));
  const fastPath = makePath(visible.map((_, index) => simpleMovingAverage(candles, fastPeriod, candles.length - visible.length + index + 1)));
  const slowPath = makePath(visible.map((_, index) => simpleMovingAverage(candles, slowPeriod, candles.length - visible.length + index + 1)));

  return <svg className="mini-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Price and moving averages"><path className="chart-grid" d="M0 18H100 M0 50H100 M0 82H100" /><path className="chart-close" d={closePath} /><path className="chart-fast" d={fastPath} /><path className="chart-slow" d={slowPath} /></svg>;
}
