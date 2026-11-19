// Server only. Never include this directory or WHOP_API_KEY in a buyer package.
import { createHash, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
export const AUDIENCE = 'AdaptiveTradingBot.Live.Subscription.v1';
export const MAX_LEASE_MS = 120_000;
// Compatibility deadline for an explicitly provisioned seller-only grant.
// Authorization still expires every 120 seconds and can be revoked centrally.
export const OWNER_TEST_UNTIL = Date.UTC(9999, 0, 1);
// Pin the reviewed legacy membership shape (company / plan / renewal_period_end).
// Never inherit a merchant key's newer default response schema silently.
export const MEMBERSHIP_API_VERSION = '2025-01-01';
const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => ({ status: 403, body: { active: false, reason: 'membership_inactive_or_not_eligible' } });
export function readSettings(env = process.env) {
  const settings = { apiKey: env.WHOP_API_KEY, companyId: env.WHOP_COMPANY_ID, productId: env.WHOP_PRODUCT_ID,
    planIds: (env.WHOP_PLAN_IDS || '').split(',').map(x => x.trim()).filter(Boolean), signingKey: env.LICENSE_SIGNING_PRIVATE_KEY,
    ownerTestLicenseHashes: (env.ASB_OWNER_TEST_LICENSE_HASHES || '').split(',').map(x => x.trim()).filter(Boolean) };
  if (!settings.apiKey || !/^biz_[A-Za-z0-9]+$/.test(settings.companyId || '') || !/^prod_[A-Za-z0-9]+$/.test(settings.productId || '') ||
      !settings.planIds.length || settings.planIds.some(x => !/^plan_[A-Za-z0-9]+$/.test(x)) || !settings.signingKey) throw new Error('Server configuration incomplete.');
  if(settings.ownerTestLicenseHashes.length>8 || settings.ownerTestLicenseHashes.some(x=>!(/^[a-f0-9]{64}$/).test(x))) throw new Error('Invalid seller test grant configuration.');
  const key = createPrivateKey(settings.signingKey.replaceAll('\\n', '\n'));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 signing key is required.');
  return { ...settings, key };
}
export function validRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(k => ['licenseKey','session','nonce'].includes(k)) &&
    ['licenseKey','session','nonce'].every(k=>typeof body[k]==='string') &&
    /^[A-Za-z0-9-]{16,128}$/.test(body.licenseKey || '') && /^[a-f0-9-]{36}$/.test(body.session || '') && /^[a-f0-9-]{36}$/.test(body.nonce || '');
}
export async function validateSubscription(body, { settings, fetchImpl = fetch, now = Date.now } = {}) {
  if (!validRequest(body)) return { status: 400, body: { active: false, reason: 'invalid_request' } };
  if (!settings?.key) return { status: 503, body: { active: false, reason: 'service_not_configured' } };
  const licenseHash=hash(body.licenseKey);
  // This is a separate, seller-issued self-test entitlement, not a rule that
  // treats free, administrator-created, canceled or expired customers as paid.
  // Only a seller-configured exact key hash can enter this branch. The public
  // API cannot add a grant. Removing the secret revokes it on the next refresh.
  if((settings.ownerTestLicenseHashes??[]).some(value=>timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(licenseHash,'hex')))) {
    return grantLease(body,settings,{planId:settings.planIds[0],paidUntil:OWNER_TEST_UNTIL,issuedAt:now(),cancelAtPeriodEnd:false,ownerTest:true});
  }
  let response, membership;
  try {
    // The merchant credential is sent ONLY to this fixed Whop origin. No redirect.
    response = await fetchImpl('https://api.whop.com/api/v1/memberships/' + encodeURIComponent(body.licenseKey), {
      method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + settings.apiKey, Accept: 'application/json', 'Api-Version-Date': MEMBERSHIP_API_VERSION }
    });
    if (response.status === 404) return denied();
    if (!response.ok) throw new Error('Upstream unavailable');
    if (Number(response.headers.get('content-length')) > 262144) throw new Error('Oversized upstream');
    membership = await readLimitedJson(response,262144);
  } catch { return { status: 503, body: { active: false, reason: 'verification_unavailable' } }; }
  const equal = typeof membership?.license_key === 'string' && timingSafeEqual(Buffer.from(hash(membership.license_key)), Buffer.from(hash(body.licenseKey)));
  // Monthly edition: never grant indefinite access for null dates / lifetime keys.
  // Cancel-at-period-end does NOT revoke an otherwise active paid period.
  const paidUntil = typeof membership?.renewal_period_end === 'string' ? Date.parse(membership.renewal_period_end) : NaN;
  const issuedAt = now();
  if (!equal || membership.company?.id !== settings.companyId || membership.product?.id !== settings.productId ||
      !settings.planIds.includes(membership.plan?.id) || !['active','trialing'].includes(membership.status) ||
      membership.valid === false || membership.payment_collection_paused === true || !Number.isSafeInteger(paidUntil) || paidUntil <= issuedAt) return denied();
  return grantLease(body,settings,{planId:membership.plan.id,paidUntil,issuedAt,cancelAtPeriodEnd:membership.cancel_at_period_end===true});
}

function grantLease(body,settings,{planId,paidUntil,issuedAt,cancelAtPeriodEnd,ownerTest=false}) {
  if(!Number.isSafeInteger(issuedAt)||issuedAt>=paidUntil) return denied();
  const claims = { v: 1, aud: AUDIENCE, companyId: settings.companyId, productId: settings.productId, planId,
    session: body.session, nonce: body.nonce, licenseHash: hash(body.licenseKey), issuedAt,
    expiresAt: Math.min(issuedAt + MAX_LEASE_MS, paidUntil), paidUntil, cancelAtPeriodEnd,
    ...(ownerTest?{entitlement:'seller_test',perpetual:true}:{}) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = payload + '.' + sign(null, Buffer.from(payload), settings.key).toString('base64url');
  // No customer identity, merchant credentials or raw Whop object leaves this service.
  return { status: 200, body: { active: true, token } };
}

async function readLimitedJson(response,maximum) {
  const reader=response.body?.getReader();if(!reader)throw new Error('Missing response');
  let size=0;const chunks=[];
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw new Error('Oversized response');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
}

// Per-instance backstop only. Production also requires host-level distributed
// rate limits/WAF. This is NOT a fleet-wide or device-seat entitlement database.
export function createLimiter({ now = Date.now, maximum = 40 } = {}) {
  const buckets = new Map();
  return identifier => {
    const time = now(), key = hash(String(identifier));
    if (buckets.size > 10000) for (const [k,b] of buckets) if (b.until <= time) buckets.delete(k);
    if (buckets.size > 10000 && !buckets.has(key)) return false;
    let b = buckets.get(key); if (!b || b.until <= time) { b = { until: time + 60000, count: 0 }; buckets.set(key,b); }
    return ++b.count <= maximum;
  };
}
