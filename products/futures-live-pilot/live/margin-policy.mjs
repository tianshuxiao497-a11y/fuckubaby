import {createHash} from 'node:crypto';
import {units,decimal,absolute,SCALE} from './math.mjs';
import {contractSymbol} from './market.mjs';
export const AUTO_MARGIN_CONFIRMATION='ENABLE JSON AUTO MARGIN';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
export function parseMarginPolicy(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>8192)throw new Error('AUTO_MARGIN_JSON_MAX_8_KB');let p;try{p=JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw new Error('INVALID_AUTO_MARGIN_JSON');}
  const keys=['version','format','id','enabled','market','symbol','asset','positionSides','trigger','perAdditionAmount','maxTotalAmount','maxAdditions','cooldownSeconds'];
  if(!exact(p,keys)||p.version!==1||p.format!=='AdaptiveAutoMargin'||!/^[-A-Za-z0-9_]{4,48}$/.test(p.id??'')||['__proto__','constructor','prototype'].includes(p.id)||typeof p.enabled!=='boolean'||!['USD_M','COIN_M'].includes(p.market)||! /^[A-Z0-9]{2,24}$/.test(p.asset??'')||!Array.isArray(p.positionSides)||!p.positionSides.length||p.positionSides.length>2||new Set(p.positionSides).size!==p.positionSides.length||p.positionSides.some(side=>!['LONG','SHORT'].includes(side))||!exact(p.trigger,['liquidationDistancePercentAtMost']))throw new Error('EXPLICIT_AUTO_MARGIN_JSON_FIELDS_REQUIRED');
  contractSymbol(p.symbol);const trigger=p.trigger.liquidationDistancePercentAtMost;
  if(typeof trigger!=='number'||!Number.isFinite(trigger)||trigger<0||trigger>20||typeof p.perAdditionAmount!=='string'||typeof p.maxTotalAmount!=='string'||!Number.isSafeInteger(p.maxAdditions)||p.maxAdditions<0||p.maxAdditions>1000||!Number.isSafeInteger(p.cooldownSeconds)||p.cooldownSeconds<0||p.cooldownSeconds>86400)throw new Error('BOUNDED_AUTO_MARGIN_RULES_REQUIRED');
  const amount=units(p.perAdditionAmount),budget=units(p.maxTotalAmount);
  if(p.enabled&&(!amount||budget<amount||trigger<=0||p.maxAdditions<1||p.cooldownSeconds<30))throw new Error('AUTO_MARGIN_AMOUNT_BUDGET_TRIGGER_AND_COOLDOWN_REQUIRED');
  return {...p,positionSides:[...p.positionSides].sort(),trigger:{...p.trigger},perAdditionAmount:decimal(amount),maxTotalAmount:decimal(budget)};
}
export const marginPolicyDigest=p=>createHash('sha256').update(JSON.stringify(p)).digest('hex');
export function registerMarginPolicy(state,policy){
  const next=structuredClone(state),existing=next.autoMarginBudgets[policy.id];
  if(existing&&(existing.market!==policy.market||existing.symbol!==policy.symbol||existing.asset!==policy.asset))throw new Error('AUTO_MARGIN_POLICY_ID_ALREADY_BOUND_TO_ANOTHER_TARGET');
  if(!existing)next.autoMarginBudgets[policy.id]={market:policy.market,symbol:policy.symbol,asset:policy.asset,usedAmount:'0',additions:0,lastAdditionAt:0};
  return next;
}
export function autoMarginDecision({policy,state,snapshot,armed,now,availableCollateral}){
  const deny=reason=>({eligible:false,reason});if(!policy)return deny('NO_EXTERNAL_AUTO_MARGIN_POLICY');if(!policy.enabled)return deny('EXTERNAL_AUTO_MARGIN_POLICY_DISABLED');if(!armed)return deny('AUTO_MARGIN_NOT_ARMED');
  if(!snapshot?.accountChecked||snapshot.market!==policy.market||snapshot.symbol!==policy.symbol||snapshot.marginAsset!==policy.asset)return deny('AUTO_MARGIN_POLICY_TARGET_MISMATCH');
  if(snapshot.configuration.marginMode!=='ISOLATED')return deny('AUTO_MARGIN_REQUIRES_ISOLATED_POSITION');if(snapshot.configuration.autoAddMargin===true)return deny('EXCHANGE_AUTO_ADD_MARGIN_ALREADY_ENABLED');if(!snapshot.actualConfigurationMatches||state.pending)return deny('AUTO_MARGIN_ACCOUNT_REVIEW_REQUIRED');if(state.day.blocked)return deny('DAILY_USDT_EQUITY_LOSS_20_PERCENT');
  if(snapshot.configuration.autoAddMargin!==false)return deny('EXCHANGE_AUTO_ADD_MARGIN_STATUS_UNAVAILABLE');
  for(const direction of ['LONG','SHORT']){const p=state.positions[direction],s=state.protections[direction];if((p&&!s)||(!p&&s)||(p&&s&&units(p.quantity)!==units(s.quantity)))return deny('AUTO_MARGIN_ACCOUNT_REVIEW_REQUIRED');}
  const budget=state.autoMarginBudgets[policy.id];if(!budget)return deny('AUTO_MARGIN_BUDGET_NOT_REGISTERED');if(budget.additions>=policy.maxAdditions||units(budget.usedAmount)+units(policy.perAdditionAmount)>units(policy.maxTotalAmount))return deny('AUTO_MARGIN_BUDGET_OR_COUNT_EXHAUSTED');if(now<budget.lastAdditionAt||now-budget.lastAdditionAt<policy.cooldownSeconds*1000)return deny('AUTO_MARGIN_COOLDOWN');
  if(units(availableCollateral)<units(policy.perAdditionAmount))return deny('AVAILABLE_COLLATERAL_INSUFFICIENT');const candidates=[];
  for(const direction of policy.positionSides){
    const position=state.positions[direction],stop=state.protections[direction],row=snapshot.configuration.legs[direction];if(!position||!stop||units(position.quantity)!==units(stop.quantity))continue;
    const mark=units(snapshot.markPrice),liquidation=typeof row?.liquidationPrice==='string'?units(row.liquidationPrice):0n;
    if(!mark||!liquidation||(direction==='LONG'?liquidation>=mark:liquidation<=mark))continue;
    const distance=absolute(mark-liquidation)*100n*SCALE/mark;if(distance>units(String(policy.trigger.liquidationDistancePercentAtMost)))continue;
    candidates.push({direction,distance});
  }
  candidates.sort((a,b)=>a.distance<b.distance?-1:1);if(!candidates.length)return deny('AUTO_MARGIN_TRIGGER_NOT_MET_OR_LIQUIDATION_UNAVAILABLE');
  return {eligible:true,direction:candidates[0].direction,amount:policy.perAdditionAmount,asset:policy.asset,policyId:policy.id,policyDigest:marginPolicyDigest(policy),liquidationDistancePercent:decimal(candidates[0].distance),budgetUsed:budget.usedAmount,budgetLimit:policy.maxTotalAmount};
}
