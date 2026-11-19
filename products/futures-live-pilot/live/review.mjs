export function reviewReport(engine){
  const state=engine.state,s=engine.last;if(!state||!s)throw new Error('FUTURES_CHECK_REQUIRED_FOR_REVIEW');
  const clean=value=>String(value??'—').replace(/[\r\n|]/g,' ');
  const lines=['# Adaptive Futures Bot · 本机复盘 / Review','',
    '此报告依据本机核对记录生成，不是收益承诺。','',
    '- 核对时间：'+new Date(s.checkedAt).toISOString(),'- 合约：'+s.market+' / '+s.symbol,
    '- 保证金模式 / 杠杆：'+s.configuration.marginMode+' / '+s.configuration.leverage+'x',
    '- 每次初始保证金预算：总合约钱包权益的 '+engine.settings.marginPercent+'%',
    '- 当前合约钱包合计权益：'+s.equityUsdt+' USDT',
    '- 日内参考权益：'+s.day.baselineUsdt+' USDT'+(s.day.firstDay?'（首日从本程序建账时刻起算）':''),
    '- 日内回撤：'+s.lossPercent.toFixed(4)+'%',
    '- 当天停止新增多空仓：'+(s.day.blocked?'是':'否'),
    '- 当前程序持仓：'+(Object.values(state.positions).filter(Boolean).map(p=>p.direction+' '+p.quantity+' '+p.symbol).join('；')||'空仓'),
    '- 交易所保护单：'+(Object.entries(state.protections).filter(([,p])=>p).map(([side,p])=>side+' '+p.status+' @ '+p.triggerPrice).join('；')||'没有已确认保护单'),
    '- 手动锁仓暂停：'+(state.hedgeLock?.active?'是':'否'),
    '- JSON 自动追加当前启用：'+(engine.autoMarginArmed?'是':'否'),
    '- 当前阻挡原因：'+clean(s.blocker),
    '- 内置 / 外置策略：'+clean(engine.settings.externalStrategy?.name??'内置 EMA / RSI / ATR 双向规则'),'',
    '## 成交记录','', '| UTC 时间 | 合约 | 动作 | 数量 | 状态 |','| --- | --- | --- | --- | --- |'];
  for(const row of state.orders.slice(-100))lines.push('| '+[new Date(row.time).toISOString(),row.market+' '+row.symbol,row.intent,row.quantity,row.status].map(clean).join(' | ')+' |');
  lines.push('','## 费用与资金费','', '佣金与已实现盈亏按交易所逐笔成交入账；资金费按原生币种的真实流水入账。滑点已体现在成交价格，不再重复扣作额外费用。','',
    '| UTC 时间 | 钱包 / 资产 | 资金费收入或支出 |','| --- | --- | --- |');
  for(const row of state.funding.slice(-100))lines.push('| '+[new Date(row.time).toISOString(),row.wallet,row.amount].map(clean).join(' | ')+' |');
  lines.push('','## 逐仓追加与自动追加预算','', '| UTC 时间 | 方向 | 追加额 | 币种 | 来源 |','| --- | --- | --- | --- | --- |');
  for(const row of state.marginEvents.slice(-100))lines.push('| '+[new Date(row.time).toISOString(),row.direction,row.amount,row.asset,row.policyId?'JSON '+row.policyId:'本人手动'].map(clean).join(' | ')+' |');
  lines.push('','追加是在合约钱包内部调配保证金，不计作额外充值或收益。相同策略 ID 的自动追加累计用量不会因重启或重复导入清零。','');
  for(const [id,budget] of Object.entries(state.autoMarginBudgets))lines.push('- '+clean(id)+'：累计 '+budget.usedAmount+' '+budget.asset+'，'+budget.additions+' 次。');
  lines.push('','## 下一轮讨论','', '1. 哪些开仓和退出条件产生了实际净收益或费用损失？','2. 保证金占比、所选杠杆和止损距离是否相容？','3. 担保币价格变化对折合 USDT 权益有多大影响？','4. 是否存在未知订单、资金变动、强平或需要到币安手动处理的记录？','5. 先保存本轮记录，再由用户确认修改策略；不自动恢复交易。','');
  return lines.join('\n');
}
