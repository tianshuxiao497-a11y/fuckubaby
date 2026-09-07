# Binance Testnet Quant Lab

一个只做模拟交易的量化策略实验台。它显示 Binance Spot Testnet 的公开 K 线，用 SMA（简单移动平均线）交叉策略驱动本地虚拟资金，**不会读取真实 Binance 余额、不会接收生产 API 密钥，也不会发送真实订单**。

## 安全边界

- 行情：只请求 `https://testnet.binance.vision/api/v3/klines` 的公开数据。
- 交易：只在浏览器 `localStorage` 记录模拟余额、持仓和订单。
- 账户：初始为 `10,000 USDT` 虚拟资金；重置只影响本机浏览器数据。
- 密钥：本项目不需要任何 API Key。请不要把 Binance 生产密钥提交到仓库或部署环境。
- Testnet：Binance 的 Testnet 虚拟数据会定期重置，且不等于真实行情或真实交易结果。

## 策略逻辑

1. 快线 SMA 向上穿越慢线 SMA 时，按“单笔虚拟资金”模拟买入。
2. 快线向下穿越慢线 SMA 时，模拟卖出。
3. 持仓达到配置的止损或止盈阈值时，模拟退出。
4. 每笔模拟交易按 0.1% 计入费用，用于让测试更接近真实交易摩擦。

这只是示例策略，不构成投资建议，也不代表可盈利策略。

## 本地运行

```powershell
npm install
npm run dev
```

打开 `http://localhost:3000`。首次可点击“恢复演示”，在无网络时用内置 K 线测试；网络可用时点击“刷新行情”或“运行一次”读取 Testnet 公开行情。

## GitHub 发布

```powershell
git init
git add .
git commit -m "Create Binance Testnet paper trading lab"
```

然后在 GitHub 新建一个空仓库，并将其 URL 作为 `origin` 后推送：

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

不要上传 `.env.local`、任何 `*.pem` / `*.key` 文件，或生产 Binance API Key。

## Binance Testnet（可选）

本项目不需要 Testnet API Key，因为它只读取公开行情。如果未来你想在 Binance 的 Testnet 内实际生成虚拟委托，请只创建 Testnet 专用密钥，且先单独审查服务端下单逻辑；绝不要复用或上传生产密钥。官方 Testnet 文档：<https://developers.binance.com/docs/binance-spot-api-docs/testnet/general-info>。
