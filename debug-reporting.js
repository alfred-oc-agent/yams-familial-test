import { BUILD_NUMBER, DIAGNOSTICS_ENABLED } from './build-profile.js';

// Contact details are supplied locally by the tester, never shipped in assets.
const RECIPIENT_STORAGE_KEY = 'yams-test-diagnostic-recipient';
let recipientInMemory = '';
export function normalizeRecipient(value) {
  if(typeof value!=='string')return '';
  const address=value.trim();
  return address.length<=254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(address) ? address : '';
}
export function getDiagnosticRecipient() {
  try {const storage=globalThis.window?.localStorage;return storage ? normalizeRecipient(storage.getItem(RECIPIENT_STORAGE_KEY)) : recipientInMemory;}
  catch {return recipientInMemory;}
}
export function setDiagnosticRecipient(value) {
  const address=normalizeRecipient(value);
  if(value && !address)throw new DiagnosticSendError('recipient');
  recipientInMemory=address;
  try {const storage=globalThis.window?.localStorage;if(address)storage?.setItem(RECIPIENT_STORAGE_KEY,address);else storage?.removeItem(RECIPIENT_STORAGE_KEY);}
  catch { /* Private browsing may retain the choice in memory only. */ }
  return address;
}
const candidateKeys = ['total','udp','tcp','mdns','ipv4','ipv6'];
const nativeCandidateKeys = [...candidateKeys,'host','srflx','prflx','relay','unknownAddress'];
const pairKeys = ['total','frozen','waiting','inProgress','succeeded','failed','other','nominated','selected'];
const checkKeys = ['requestsSent','responsesReceived','requestsReceived','responsesSent'];
const states = {
  signaling: ['stable','have-local-offer','have-remote-offer','have-local-pranswer','have-remote-pranswer','closed'],
  ice: ['new','checking','connected','completed','disconnected','failed','closed'],
  gathering: ['new','gathering','complete'],
  connection: ['new','connecting','connected','disconnected','failed','closed'],
  channel: ['none','connecting','open','closing','closed'],
  failure: ['connectionFailed','pairError','unsupported'],
  event: ['signaling','gathering','connection','ice','failure','ready','answer-accepted','channel-open','channel-closed','channel-error','attempt-tag'],
};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const counters = (value, keys) => Object.fromEntries(keys.map(key => [key, count(value?.[key])]));
const state = (key, value) => states[key].includes(value) ? value : null;
const safeTag=value=>/^[a-f0-9]{32}$/.test(value??'')?value:null;
const scopeKeys=['privateIpv4','sharedIpv4','publicIpv4','loopback','linkLocal','uniqueLocalIpv6','publicIpv6','mdns','unspecified','unknown'];
function transportSide(input) {
  if(!input || typeof input!=='object')return null;
  return {descriptionTag:safeTag(input.descriptionTag),credentialsTag:safeTag(input.credentialsTag),candidatesTag:safeTag(input.candidatesTag),
    privatePrefixTags:Array.isArray(input.privatePrefixTags)?input.privatePrefixTags.map(safeTag).filter(Boolean).slice(0,16):[],
    scopes:counters(input.scopes,scopeKeys),zeroPorts:count(input.zeroPorts)};
}
function environment(input) {
  if(!input || typeof input!=='object')return null;
  const permissions=Object.fromEntries(['localNetwork','loopbackNetwork','legacyLocalNetwork','camera'].map(key=>[key,['granted','denied','prompt','unsupported','unavailable'].includes(input[key])?input[key]:'unavailable']));
  return {...permissions,secureContext:input.secureContext===true,visibility:['visible','hidden'].includes(input.visibility)?input.visibility:'unknown'};
}
function selfTestSide(input) {
  if(!input || typeof input!=='object')return null;
  const safe=sanitizeDiagnostic(input,false);
  return {ready:safe.ready,ice:safe.ice,connection:safe.connection,channel:safe.channel,local:safe.local,remote:safe.remote,connectivity:safe.connectivity};
}

// Re-project at the outbound boundary: never spread a diagnostic/native object.
export function sanitizeDiagnostic(input = {}, includeSelfTest = true) {
  if(!input || typeof input!=='object')input={};
  const result = { version: Number.isSafeInteger(input.version)&&input.version>=1&&input.version<=BUILD_NUMBER?input.version:BUILD_NUMBER,
    kind:input.kind==='local-test'?'local-test':'pairing',role: ['manager','observer','device'].includes(input.role) ? input.role : 'unknown',
    attemptId: /^[a-f0-9]{16}$/.test(input.attemptId ?? '') ? input.attemptId : null,
    ready: input.ready === true, failure: state('failure',input.failure),
    ...Object.fromEntries(['signaling','ice','gathering','connection','channel'].map(key=>[key,state(key,input[key])])),
    local: counters(input.local,candidateKeys), remote: counters(input.remote,candidateKeys),
    transitions: Array.isArray(input.transitions) ? input.transitions.slice(-16).map(item=>({ms:count(item?.ms),
      event:state('event',item?.event),ice:state('ice',item?.ice),connection:state('connection',item?.connection),channel:state('channel',item?.channel)})) : [],
  };
  const network=input.connectivity;
  result.connectivity = network?.available === true ? {
    available:true,sampledAtMs:count(network.sampledAtMs),
    local:counters(network.local,nativeCandidateKeys),remote:counters(network.remote,nativeCandidateKeys),
    pairs:counters(network.pairs,pairKeys),checks:counters(network.checks,checkKeys),counterCoverage:counters(network.counterCoverage,checkKeys),
    dtlsStates:Array.isArray(network.dtlsStates) ? [...new Set(network.dtlsStates.filter(value=>['new','connecting','connected','closed','failed'].includes(value)))].sort() : [],
  } : {available:false,reason:['pending','unsupported','unavailable'].includes(network?.reason) ? network.reason : 'unavailable'};
  result.environment=environment(input.environment);
  result.transport=input.transport?.available===true?{available:true,sampledAtMs:count(input.transport.sampledAtMs),
    local:transportSide(input.transport.local),remote:transportSide(input.transport.remote),sharedPrivatePrefix24:count(input.transport.sharedPrivatePrefix24)}:{available:false};
  if(includeSelfTest && ['passed','failed'].includes(input.selfTest?.result))result.selfTest={
    result:input.selfTest.result,durationMs:count(input.selfTest.durationMs),completedAt:count(input.selfTest.completedAt),
    failure:['connectionFailed','pairError','unsupported','timeout','stateMismatch','setup'].includes(input.selfTest.failure)?input.selfTest.failure:null,
    manager:selfTestSide(input.selfTest.manager),observer:selfTestSide(input.selfTest.observer),
  };
  return result;
}

export function deviceSummary(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? '';
  const ipad = /iPad/.test(ua) || /Macintosh/.test(ua) && nav?.maxTouchPoints > 1;
  const browser = /(?:Firefox|FxiOS)\/([\d.]+)/.exec(ua) ?? /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua) ?? /Version\/([\d.]+).*Safari/.exec(ua);
  return {
    browser: /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'other',
    browserVersion: browser?.[1]?.slice(0,20) ?? 'unknown',
    platform: ipad ? 'iPadOS' : /iPhone/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : 'other',
    installed: globalThis.matchMedia?.('(display-mode: standalone)').matches === true || nav?.standalone === true,
  };
}

export function createDiagnosticReport(input, { reportId = crypto.randomUUID(), now = new Date(), navigator: nav = globalThis.navigator } = {}) {
  return {schema:1,build:BUILD_NUMBER,profile:'test',reportId,reportedAt:now.toISOString(),device:deviceSummary(nav),diagnostic:sanitizeDiagnostic(input)};
}

function subject(report) {return `[YAMS-TEST] v${BUILD_NUMBER} ${report.diagnostic.role} ${report.device.browser} ${report.diagnostic.attemptId??'no-attempt'}`;}

// The same outbound allowlist applies to email drafts, shared files and HTTPS.
export function diagnosticExport(input, options = {}) {
  const report=createDiagnosticReport(input,options);
  const text=JSON.stringify(report,null,2);
  const recipient=normalizeRecipient(options.recipient ?? getDiagnosticRecipient());
  const mailto=`mailto:${encodeURIComponent(recipient).replace('%40','@')}?subject=${encodeURIComponent(subject(report))}&body=${encodeURIComponent(text)}`;
  return {text,mailto,reportId:report.reportId,fileName:`yams-diagnostic-v${BUILD_NUMBER}-${report.diagnostic.role}-${report.reportId.slice(0,8)}.json`};
}

export class DiagnosticSendError extends Error {
  constructor(code,status=null){super(code);this.name='DiagnosticSendError';this.code=code;this.status=status;}
}

export async function sendDiagnostic(input, { fetchImpl = globalThis.fetch, reportId, recipient = getDiagnosticRecipient() } = {}) {
  if (!DIAGNOSTICS_ENABLED) throw Error('diagnostics-disabled');
  const destination=normalizeRecipient(recipient);
  if(!destination)throw new DiagnosticSendError('recipient');
  if (globalThis.navigator?.onLine === false) throw new DiagnosticSendError('offline');
  const report=createDiagnosticReport(input,{reportId});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try {
    // FormSubmit requires a Referer. Send only the public origin, never a page URL.
    const response=await fetchImpl(`https://formsubmit.co/ajax/${encodeURIComponent(destination)}`,{method:'POST',credentials:'omit',referrerPolicy:'origin',
      headers:{'Content-Type':'application/json','Accept':'application/json'},signal:controller.signal,
      body:JSON.stringify({_subject:subject(report),
        _captcha:'false',_template:'table',report:JSON.stringify(report,null,2)}),
    });
    if(!response.ok)throw new DiagnosticSendError('service',response.status);
    let result;try{result=await response.json();}catch{throw new DiagnosticSendError('response');}
    if(![true,'true'].includes(result?.success)) throw new DiagnosticSendError('rejected');
    return {reportId:report.reportId};
  } catch(error) {
    if(error instanceof DiagnosticSendError)throw error;
    throw new DiagnosticSendError(controller.signal.aborted?'timeout':'network');
  } finally {clearTimeout(timer);}
}
