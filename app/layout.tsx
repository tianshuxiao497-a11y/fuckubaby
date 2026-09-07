import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Binance Testnet Quant Lab",
  description: "A paper-only trading laboratory using Binance Spot Testnet market data."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
