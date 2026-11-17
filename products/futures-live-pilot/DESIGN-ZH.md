# 合约实盘版设计与验收

当前为开发中的独立合约版；既有现货实盘 ZIP 和测试网客户下载保持原样。目标是 Windows x64、Linux x64、Mac arm64、Mac x64 的同版本原生 ZIP，附中英文说明。

## 用户已确认

- 币安 U 本位与币本位永续合约；可做多、做空。
- 全仓、逐仓都可选；杠杆选项以币安返回的当前合约、账户和持仓档位为准，由用户选择。
- 每次开仓的初始保证金占总权益 1%–2%，不是合约名义金额占 1%–2%。所选杠杆再决定名义仓位。
- 币本位日内回撤按折合 USDT 的权益计算，包含担保币本身的涨跌。
- UTC+8 零点分界，日内回撤超过 20% 时锁定新增多空仓；仍可减仓、平仓，恢复权益不解除当天锁定。
- 内置自动策略、外置 JSON 导入；先卖家自用测试，后续再接独立客户订阅交付。

## 执行与账本

线性合约与反向合约使用各自的盈亏、张数和保证金公式。以实际成交、实际佣金和实际资金费入账；滑点体现在真实成交价格中，不再作为一笔额外费用重复扣除。开仓前另行预留费用，只影响可用保证金检查。

账户、仓位、杠杆、保证金模式、挂单及条件保护单核对通过后，用户手动确认启动。写请求先保存唯一意图；超时只核对原订单，不重复开仓。平仓方向和 positionSide 分开校验。未知或手动仓位不接管。

默认保留账户现有持仓模式；不自动切换 UM/CM 共用的双向持仓设置。不自动使用交易所最高杠杆。全仓初始保证金占比不代表该笔交易的最大亏损上限；逐仓也须区分追加保证金、佣金、资金费和强平费用。

交易所侧保护使用当前条件单接口。开仓与保护并非原子请求；不能把本机策略运行、止损触发或日内停开仓描述为保证最大亏损。断线、关机和结果不明需分别验收。

## 官方接口依据（2026-11-17 核对）

- [U 本位交易接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)
- [币本位交易接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-coin-m-futures/api/rest-api/trade)
- [币本位与 U 本位架构整合](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/Important-CM-UM-Integration-Notice)
- [币安合约费用](https://www.binance.com/en/support/faq/detail/98488a516eb84e3eb34605683dffd554)

整合公告指出两类账户共享持仓模式和限频；条件止损改用 Algo 接口；下单即时响应不能当作成交证明。实现与验收需覆盖这些变更。
