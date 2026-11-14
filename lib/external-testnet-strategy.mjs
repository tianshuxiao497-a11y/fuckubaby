// User files contain bounded data rules. Never load them as code.
export const EXTERNAL_STRATEGY_BYTES = 8192;
const metrics = new Set(['fast', 'slow', 'previousFast', 'previousSlow', 'rsi',
  'previousRsi', 'atrPercent', 'volumeRatio', 'contextBiasPercent',
  'momentumPercent', 'spreadPercent', 'close', 'previousClose', 'positionReturnPercent']);
const comparisons = {
  '>': (a,b)=>a>b, '>=': (a,b)=>a>=b, '<': (a,b)=>a<b, '<=': (a,b)=>a<=b,
  '==': (a,b)=>a===b,
};
const has = (o,k) => Object.hasOwn(o,k);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) &&
  Object.keys(o).length === keys.length && keys.every(k=>has(o,k));
const operand = x => typeof x === 'number' ? Number.isFinite(x) && Math.abs(x) <= 1e9 : metrics.has(x);

export function parseExternalStrategy(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text,'utf8') > EXTERNAL_STRATEGY_BYTES)
    throw new Error('策略文件最大 8 KB / Strategy exceeds 8 KB.');
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('策略文件不是有效 JSON / Invalid strategy JSON.'); }
  if (!exact(doc,['version','name','entry','exit']) || doc.version !== 1 ||
      typeof doc.name !== 'string' || !/^[\p{L}\p{N} _().-]{1,60}$/u.test(doc.name.trim()))
    throw new Error('需要 version:1、name、entry 和 exit / Invalid strategy header.');
  const groups = {};
  for (const side of ['entry','exit']) {
    const group = doc[side];
    if (!exact(group,['match','rules']) || !['all','any'].includes(group.match) ||
        !Array.isArray(group.rules) || group.rules.length < 1 || group.rules.length > 12)
      throw new Error(`${side} 需要 all/any 和 1–12 条规则 / Invalid rule group.`);
    groups[side] = {match:group.match,rules:group.rules.map((rule,index)=>{
      if (!exact(rule,['left','op','right']) || !operand(rule.left) || !operand(rule.right) ||
          typeof rule.op !== 'string' || !has(comparisons,rule.op) ||
          (!metrics.has(rule.left) && !metrics.has(rule.right)) ||
          (side==='entry' && [rule.left,rule.right].includes('positionReturnPercent')))
        throw new Error(`${side} 规则 ${index+1} 的指标或运算符不支持 / Unsupported operand or operator.`);
      return {left:rule.left,op:rule.op,right:rule.right};
    })};
  }
  return {version:1,name:doc.name.trim(),...groups};
}

export function externalRulesMatch(group, values) {
  const checks = group.rules.map(rule => {
    const read = x => typeof x==='number' ? x : has(values,x) ? values[x] : null;
    const left=read(rule.left), right=read(rule.right);
    return Number.isFinite(left) && Number.isFinite(right) && comparisons[rule.op](left,right);
  });
  return group.match==='all' ? checks.every(Boolean) : checks.some(Boolean);
}
