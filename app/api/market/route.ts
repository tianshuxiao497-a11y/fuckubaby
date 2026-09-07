import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const allowedSymbols = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
const allowedIntervals = new Set(["1m", "5m", "15m", "1h"]);

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

function toFiniteNumber(value: string | number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function fallbackMarket(symbol: string, interval: string, notice: string) {
  const base = symbol === "BTCUSDT" ? 68_000 : symbol === "ETHUSDT" ? 3_600 : 145;
  const intervalMilliseconds = interval === "1m" ? 60_000 : interval === "5m" ? 300_000 : interval === "15m" ? 900_000 : 3_600_000;
  const start = Date.now() - 120 * intervalMilliseconds;
  let previous = base * 0.965;
  const candles = Array.from({ length: 120 }, (_, index) => {
    const wave = Math.sin(index / 5.4) * 0.006 + Math.cos(index / 12.5) * 0.009;
    const trend = index < 52 ? index * 0.00034 : (104 - index) * 0.00022;
    const close = base * (1 + wave + trend);
    const open = previous;
    previous = close;
    return {
      time: start + index * intervalMilliseconds,
      open,
      high: Math.max(open, close) * 1.0025,
      low: Math.min(open, close) * 0.9975,
      close
    };
  });

  return Response.json(
    {
      candles,
      source: "内置演示行情（Testnet 暂不可用）",
      marketNotice: notice,
      fetchedAt: new Date().toISOString()
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  const interval = searchParams.get("interval") ?? "5m";

  if (!allowedSymbols.has(symbol) || !allowedIntervals.has(interval)) {
    return Response.json({ error: "Unsupported market request." }, { status: 400 });
  }

  const endpoint = new URL("https://testnet.binance.vision/api/v3/klines");
  endpoint.searchParams.set("symbol", symbol);
  endpoint.searchParams.set("interval", interval);
  endpoint.searchParams.set("limit", "120");

  try {
    const upstream = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!upstream.ok) {
      return fallbackMarket(symbol, interval, "Binance Testnet 当前不可访问，已切换为内置演示行情。");
    }

    const raw = (await upstream.json()) as unknown;
    if (!Array.isArray(raw)) {
      return fallbackMarket(symbol, interval, "Testnet 返回了无法解析的数据，已切换为内置演示行情。");
    }

    const candles = raw
      .filter((row): row is BinanceKline => Array.isArray(row) && row.length >= 6)
      .map((row) => {
        const time = toFiniteNumber(row[0]);
        const open = toFiniteNumber(row[1]);
        const high = toFiniteNumber(row[2]);
        const low = toFiniteNumber(row[3]);
        const close = toFiniteNumber(row[4]);

        if ([time, open, high, low, close].some((value) => value === null)) {
          return null;
        }

        return { time, open, high, low, close };
      })
      .filter((candle): candle is { time: number; open: number; high: number; low: number; close: number } =>
        candle !== null
      );

    if (candles.length < 30) {
      return fallbackMarket(symbol, interval, "Testnet 返回的 K 线不足，已切换为内置演示行情。");
    }

    return Response.json(
      {
        candles,
        source: "Binance Spot Testnet",
        fetchedAt: new Date().toISOString()
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return fallbackMarket(symbol, interval, "无法连接 Binance Testnet，已切换为内置演示行情。");
  }
}
