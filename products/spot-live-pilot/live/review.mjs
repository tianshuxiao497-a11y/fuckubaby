export function reviewReport(engine) {
  const last = engine.last;
  if (!last) throw new Error('READ_ONLY_CHECK_REQUIRED_FOR_REVIEW');
  const date = last.day.date;
  const todays = engine.state.fills.filter(fill => new Date(fill.time + 28800000).toISOString().slice(0, 10) === date);
  const rows = todays.map(fill => `| ${new Date(fill.time + 28800000).toISOString().slice(11, 19)} | ${fill.symbol} | ${fill.side} | ${fill.quantity} | ${fill.quote} | ${fill.commission} ${fill.commissionAsset} |`);
  return [
    `# Adaptive Spot Bot 实盘复盘 · ${date}`,
    '', '时间口径为 UTC+8。权益统计覆盖本程序的 USDT 账本与本程序买入的持仓。',
    '', `- 当日参考权益 ${last.day.equity} USDT`,
    `- 当前扣除预估卖出费用后的权益 ${last.equity} USDT`,
    `- 当日权益变化 ${(Number(last.equity) - Number(last.day.equity)).toFixed(8)} USDT`,
    `- 当日回撤 ${last.lossPercent.toFixed(4)}%`,
    `- 仓位比例 ${engine.settings.buyPercent}% 可用 USDT / 每次买入信号`,
    `- 策略 ${engine.settings.externalStrategy?.name ?? '内置自适应 EMA / RSI / ATR'}`,
    `- 买入锁定 ${last.buyBlocked ?? '未触发'}`,
    `- 最新判断 ${last.signal.reason}`,
    `- 执行阻挡 ${last.blocker ?? '无'}`,
    `- 零点基准来源 ${last.day.source}`,
    '', '| 时间 | 币对 | 方向 | 数量 | 成交 USDT | 实际费用 |',
    '|---|---|---|---|---|---|', ...rows,
    '', '## 和客户讨论的事项', '',
    '1. 亏损主要来自方向判断、点差、费用，还是退出时机？',
    '2. 是否调整仓位比例、进入规则或持仓时间？写出变更理由。',
    '3. 对照相同历史区间比较费用后的结果，并单独记录验证区间。',
    '4. 用户确认新方案后再导入规则。复盘报告本身不会修改策略。',
    '', '成交费用按原币种列出。其他币种费用的 USDT 估值含 1% 保守缓冲。',
    '首次建立本程序账本的当日以建账资本为起点，后续零点基准使用成交账本和零点一分钟开盘价重建。',
    '20% 是停买触发条件。实际成交、网络和价格波动会影响最终损失。', '',
  ].join('\n');
}
