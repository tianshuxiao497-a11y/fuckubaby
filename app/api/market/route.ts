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
  // Never silently mix generated demonstration prices with an existing account.
  return Response.json({ error: notice, symbol, interval }, { status: 503, headers: { "Cache-Control": "no-store" } });
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
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000)
    });

    if (!upstream.ok) {
      return fallbackMarket(symbol, interval, "Binance Testnet 当前不可访问，已停止本次模拟交易。");
    }

    const raw = (await upstream.json()) as unknown;
    if (!Array.isArray(raw)) {
      return fallbackMarket(symbol, interval, "Testnet 数据无法解析，已停止本次模拟交易。");
    }

    const candles = raw
      .filter((row): row is BinanceKline => Array.isArray(row) && row.length >= 7 && Number(row[6]) < Date.now())
      .map((row) => {
        const time = toFiniteNumber(row[0]);
        const open = toFiniteNumber(row[1]);
        const high = toFiniteNumber(row[2]);
        const low = toFiniteNumber(row[3]);
        const close = toFiniteNumber(row[4]);

        if ([time, open, high, low, close].some((value) => value === null) || !close || close <= 0) {
          return null;
        }

        return { time, open, high, low, close };
      })
      .filter((candle): candle is { time: number; open: number; high: number; low: number; close: number } =>
        candle !== null
      );

    if (candles.length < 30) {
      return fallbackMarket(symbol, interval, "Testnet 已收盘 K 线不足，已停止本次模拟交易。");
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
    return fallbackMarket(symbol, interval, "无法连接 Binance Testnet，已停止本次模拟交易。");
  }
}
