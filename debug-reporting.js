import { BUILD_NUMBER, DIAGNOSTICS_ENABLED } from './build-profile.js';

// Public form destination, not a credential. Excluded from production artifacts.
const ENDPOINT = 'https://formsubmit.co/ajax/alfred.oc.agent@gmail.com';
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

// Re-project at the outbound boundary: never spread a diagnostic/native object.
export function sanitizeDiagnostic(input = {}) {
  const result = { version: BUILD_NUMBER, role: ['manager','observer'].includes(input.role) ? input.role : 'unknown',
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

export async function sendDiagnostic(input, { fetchImpl = globalThis.fetch, reportId } = {}) {
  if (!DIAGNOSTICS_ENABLED) throw Error('diagnostics-disabled');
  if (globalThis.navigator?.onLine === false) throw Error('diagnostics-offline');
  const report=createDiagnosticReport(input,{reportId});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20_000);
  try {
    // FormSubmit requires a Referer. Send only the public origin, never a page URL.
    const response=await fetchImpl(ENDPOINT,{method:'POST',credentials:'omit',referrerPolicy:'origin',
      headers:{'Content-Type':'application/json','Accept':'application/json'},signal:controller.signal,
      body:JSON.stringify({_subject:`[YAMS-TEST] v${BUILD_NUMBER} ${report.diagnostic.role} ${report.device.browser} ${report.diagnostic.attemptId??'no-attempt'}`,
        _captcha:'false',_template:'table',report:JSON.stringify(report,null,2)}),
    });
    const result=await response.json();
    if(!response.ok || ![true,'true'].includes(result?.success)) throw Error('diagnostic-send-failed');
    return {reportId:report.reportId};
  } finally {clearTimeout(timer);}
}
