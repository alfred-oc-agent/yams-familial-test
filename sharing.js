import { CATEGORIES, GAME_FORMATS, columnsForFormat, gameFormat, emptyPlayer, isCellPlayable, validateScore, isGameComplete } from './scoring.js';
import { BUILD_NUMBER, DIAGNOSTICS_ENABLED } from './build-profile.js';

const SIGNAL_TTL = 5 * 60_000;
const MAX_MESSAGE = 64_000;
const MAX_SIGNAL = 16_000;
export const PAIRING_BUILD = BUILD_NUMBER;

// Explicit allowlist: profile IDs, local settings and historical statistics never leave the manager.
export function sharedGame(game) {
  const ids = new Map(game.basePlayers.map((player, index) => [player.id, String(index)]));
  return {
    id: game.id, format: gameFormat(game), status: game.status,
    basePlayers: game.basePlayers.map((player) => ({ id: ids.get(player.id), name: player.name })),
    timeline: { cursor: game.timeline.cursor, events: game.timeline.events.map((event) => ({
      playerId: ids.get(event.playerId), columnId: event.columnId, categoryId: event.categoryId,
      entry: event.entry.kind === 'sacrifice' ? {kind:'sacrifice'} : {kind:'score',score:event.entry.score},
    })) },
  };
}

export function validateSharedGame(input) {
  if (!input || typeof input.id !== 'string' || input.id.length > 100 || !GAME_FORMATS.includes(input.format) || !['active','completed','abandoned'].includes(input.status)) throw Error('state');
  const base = input.basePlayers;
  if (!Array.isArray(base) || base.length < 1 || base.length > 12 || new Set(base.map(p=>p?.id)).size !== base.length) throw Error('players');
  if (base.some(p=>typeof p?.id !== 'string' || p.id.length > 60 || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 24)) throw Error('players');
  const timeline = input.timeline;
  const columns = columnsForFormat(input);
  if (!timeline || !Array.isArray(timeline.events) || timeline.events.length > base.length * columns.length * CATEGORIES.length || !Number.isInteger(timeline.cursor) || timeline.cursor < 0 || timeline.cursor > timeline.events.length) throw Error('timeline');
  const players = base.map(emptyPlayer);
  let completeAtCursor = false;
  for (let i=0; i<timeline.events.length; i++) {
    const event=timeline.events[i], player=players[i % players.length];
    if (!event || event.playerId !== player.id || !columns.includes(event.columnId) || !isCellPlayable(player,event.columnId,event.categoryId)) throw Error('event');
    if (!event.entry || !['score','sacrifice'].includes(event.entry.kind) || event.entry.kind === 'score' && !validateScore(event.categoryId,event.entry.score,player.columns[event.columnId])) throw Error('score');
    player.columns[event.columnId][event.categoryId]=event.entry;
    if (i+1===timeline.cursor) completeAtCursor=isGameComplete(players,input);
  }
  if (input.status === 'completed' && !completeAtCursor) throw Error('unfinished');
  if (input.status === 'active' && completeAtCursor) throw Error('finished');
  return sharedGame(input); // also strips all unknown fields from an untrusted peer
}

async function transform(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(mode);
  const reader=stream.getReader(); const chunks=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.length; if(size>MAX_SIGNAL) throw Error('signal-size');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); }
  const result=new Uint8Array(size); let offset=0;
  for (const chunk of chunks) {result.set(chunk,offset);offset+=chunk.length;}
  return result;
}
export async function encodeSignal(signal) {
  let bytes=new TextEncoder().encode(JSON.stringify(signal));
  let kind='J';
  if (globalThis.CompressionStream) { bytes=await transform(bytes,new CompressionStream('deflate')); kind='D'; }
  const encoded=`YAMS1${kind}:`+btoa(String.fromCharCode(...bytes));
  // The single QR uses error correction L and must stay within its byte capacity.
  if(encoded.length>2900) throw Error('signal-size');
  return encoded;
}
export async function decodeSignal(text, type, session = null) {
  if(typeof text!=='string'||text.length>4000||!/^YAMS1[JD]:/.test(text)) throw Error('invalidQr');
  let bytes;
  try {
    bytes=Uint8Array.from(atob(text.slice(7)),c=>c.charCodeAt(0));
    if(text[5]==='D') bytes=await transform(bytes,new DecompressionStream('deflate'));
    const signal=JSON.parse(new TextDecoder().decode(bytes));
    if(signal.type!==type || typeof signal.session!=='string' || signal.session.length>80 || session && signal.session!==session || !Number.isFinite(signal.expires) || Date.now()>signal.expires+30_000 || signal.expires>Date.now()+SIGNAL_TTL+60_000 || typeof signal.sdp!=='string' || !signal.sdp.startsWith('v=0') || signal.sdp.length>MAX_SIGNAL) throw Error();
    return signal;
  } catch { throw Error('invalidQr'); }
}
function gatherIce(pc) {
  if(pc.iceGatheringState==='complete') return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(Error('pairError'));},12_000);
    const changed=()=>{if(pc.iceGatheringState==='complete'){cleanup();resolve();}else if(pc.signalingState==='closed'){cleanup();reject(Error('cancelled'));}};
    const cleanup=()=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',changed);pc.removeEventListener('signalingstatechange',changed);};
    pc.addEventListener('icegatheringstatechange',changed);pc.addEventListener('signalingstatechange',changed);changed();
  });
}

// Counts only: never put IPs, SDP, session secrets or player data in a diagnostic.
export function summarizeCandidates(sdp = '') {
  const result = {total:0, udp:0, tcp:0, mdns:0, ipv4:0, ipv6:0};
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const fields=line.split(/\s+/), address=fields[4] ?? '';
    result.total++;
    const protocol=fields[2]?.toLowerCase(); if(protocol==='udp'||protocol==='tcp')result[protocol]++;
    if(address.endsWith('.local'))result.mdns++;
    else if(address.includes(':'))result.ipv6++;
    else if(/^\d+\.\d+\.\d+\.\d+$/.test(address))result.ipv4++;
  }
  return result;
}

// RTCStats contains addresses, certificates and stable IDs. Copy only fixed counters.
export function summarizeConnectivityStats(report) {
  const candidates=()=>({total:0,udp:0,tcp:0,host:0,srflx:0,prflx:0,relay:0,mdns:0,ipv4:0,ipv6:0,unknownAddress:0});
  const local=candidates(),remote=candidates();
  const pairs={total:0,frozen:0,waiting:0,inProgress:0,succeeded:0,failed:0,other:0,nominated:0,selected:0};
  const checks={requestsSent:null,responsesReceived:null,requestsReceived:null,responsesSent:null};
  const counterCoverage={requestsSent:0,responsesReceived:0,requestsReceived:0,responsesSent:0};
  const entries=[...report.values()],selectedIds=new Set(),dtlsStates=new Set();
  for(const entry of entries)if(entry?.type==='transport') {
    if(entry.selectedCandidatePairId)selectedIds.add(entry.selectedCandidatePairId);
    if(['new','connecting','connected','closed','failed'].includes(entry.dtlsState))dtlsStates.add(entry.dtlsState);
  }
  for(const entry of entries) {
    if(entry?.type==='local-candidate'||entry?.type==='remote-candidate') {
      const target=entry.type==='local-candidate'?local:remote;target.total++;
      const protocol=entry.protocol?.toLowerCase();if(protocol==='udp'||protocol==='tcp')target[protocol]++;
      if(['host','srflx','prflx','relay'].includes(entry.candidateType))target[entry.candidateType]++;
      const address=entry.address??entry.ip??'';
      if(typeof address==='string' && address.endsWith('.local'))target.mdns++;
      else if(typeof address==='string' && address.includes(':'))target.ipv6++;
      else if(typeof address==='string' && /^\d+\.\d+\.\d+\.\d+$/.test(address))target.ipv4++;
      else target.unknownAddress++;
    } else if(entry?.type==='candidate-pair') {
      pairs.total++;
      const state=entry.state==='in-progress'?'inProgress':['frozen','waiting','succeeded','failed'].includes(entry.state)?entry.state:'other';
      pairs[state]++;
      if(entry.nominated===true)pairs.nominated++;
      if(entry.selected===true||selectedIds.has(entry.id))pairs.selected++;
      for(const key of Object.keys(checks))if(Number.isSafeInteger(entry[key]) && entry[key]>=0) {
        checks[key]=Math.min(Number.MAX_SAFE_INTEGER,(checks[key]??0)+entry[key]);counterCoverage[key]++;
      }
    }
  }
  return {local,remote,pairs,checks,counterCoverage,dtlsStates:[...dtlsStates].sort()};
}

export function createPeer(role, callbacks = {}, { diagnostics: debug = DIAGNOSTICS_ENABLED } = {}) {
  if(!globalThis.RTCPeerConnection) throw Error('unsupported');
  // No default public STUN, TURN or signalling service, including in dependencies.
  const pc=new RTCPeerConnection({iceServers:[],iceCandidatePoolSize:0,bundlePolicy:'max-bundle'});
  let channel, session=crypto.randomUUID(), expires=Date.now()+SIGNAL_TTL;
  let closed=false, live=false, lastSeen=Date.now(), heartbeat=null, ready=false;
  let serial=0, acknowledged=0, finishing=null, connectingDeadline=null;
  let failure=null,attemptId=null; const transitions=[]; const created=Date.now();
  let connectivity={available:false,reason:'pending'},statsBusy=false;
  let transport={available:false},environment=null,technicalTimer=null,technicalBusy=false,technicalKey=null;
  const technicalModule=debug?import('./peer-diagnostics.js'):null;
  if(debug)void technicalModule.then(module=>module.readEnvironment()).then(value=>{
    if(!closed){environment=value;callbacks.onDiagnostics?.(diagnostics());}
  }).catch(()=>{});
  const statsTimer=debug ? setInterval(refreshConnectivity,1000) : null;
  if(debug) {queueMicrotask(refreshConnectivity);if(role==='manager')void tagAttempt();}
  const deadline=setTimeout(()=>{if(!ready)fail('pairError');},SIGNAL_TTL);
  function diagnostics() {return debug ? {version:PAIRING_BUILD,attemptId,role,ready,failure,signaling:pc.signalingState,ice:pc.iceConnectionState,gathering:pc.iceGatheringState,connection:pc.connectionState,channel:channel?.readyState??'none',local:summarizeCandidates(pc.localDescription?.sdp),remote:summarizeCandidates(pc.remoteDescription?.sdp),connectivity,transport,environment,transitions:[...transitions]} : null;}
  async function refreshTransport() {
    if(!debug||closed)return;
    if(technicalBusy){technicalTimer=setTimeout(refreshTransport,50);return;}
    const local=pc.localDescription?.sdp??'',remote=pc.remoteDescription?.sdp??'',salt=session;
    const key=`${salt}\0${local}\0${remote}`;
    if(key===technicalKey)return;
    technicalBusy=true;
    try {
      const module=await technicalModule,value=await module.describeTransport(local,remote,salt);
      if(closed)return;
      if(local!==(pc.localDescription?.sdp??'')||remote!==(pc.remoteDescription?.sdp??'')||salt!==session){technicalTimer=setTimeout(refreshTransport,50);return;}
      transport={...value,sampledAtMs:Date.now()-created};technicalKey=key;callbacks.onDiagnostics?.(diagnostics());
    } catch { /* Instrumentation failure must not change negotiation. */ }
    finally {technicalBusy=false;}
  }
  async function tagAttempt() {
    if(!debug || !crypto.subtle)return;
    const current=session;
    try {
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`yams-debug-attempt:${current}`));
      if(closed || current!==session)return;
      attemptId=[...new Uint8Array(digest)].slice(0,8).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      report('attempt-tag');
    } catch { /* A debug tag must never prevent pairing. */ }
  }
  async function refreshConnectivity() {
    if(!debug||closed||ready||statsBusy)return;
    if(typeof pc.getStats!=='function') {connectivity={available:false,reason:'unsupported'};clearInterval(statsTimer);callbacks.onDiagnostics?.(diagnostics());return;}
    statsBusy=true;
    try {
      const stats=await pc.getStats();
      if(closed||ready)return;
      connectivity={available:true,sampledAtMs:Date.now()-created,...summarizeConnectivityStats(stats)};
      callbacks.onDiagnostics?.(diagnostics());
    } catch {if(!closed&&!ready){connectivity={available:false,reason:'unavailable'};callbacks.onDiagnostics?.(diagnostics());}}
    finally {statsBusy=false;}
  }
  function report(event) {
    if(!debug||closed)return;
    clearTimeout(technicalTimer);technicalTimer=setTimeout(refreshTransport,50);
    transitions.push({ms:Date.now()-created,event,ice:pc.iceConnectionState,connection:pc.connectionState,channel:channel?.readyState??'none'});
    if(transitions.length>16)transitions.shift();
    callbacks.onDiagnostics?.(diagnostics());
  }
  function fail(code) {if(closed||ready)return;failure=code;report('failure');callbacks.onError?.(code);close();}
  function markReady() {ready=true;clearTimeout(deadline);clearTimeout(connectingDeadline);clearInterval(statsTimer);report('ready');}
  const status=(value)=>{if(value!==live){live=value;callbacks.onStatus?.(value);}};
  function send(message) {
    if(channel?.readyState!=='open') return false;
    const raw=JSON.stringify(message);
    if(new TextEncoder().encode(raw).length>MAX_MESSAGE || channel.bufferedAmount>256_000) return false;
    try {channel.send(raw);return true;}catch{return false;}
  }
  function publish(noticeId=null) {
    const game=callbacks.getState?.();
    if(role==='manager' && game) send({type:'state',serial:++serial,game:sharedGame(game),noticeId});
  }
  function receive(event) {
    if(typeof event.data!=='string' || event.data.length>MAX_MESSAGE) return;
    let message; try{message=JSON.parse(event.data);}catch{return;}
    const wasLive=live; lastSeen=Date.now();
    if(ready) status(true);
    if(message.type==='ping') {send({type:'pong'});if(!wasLive){if(role==='manager')publish();else if(ready)send({type:'sync'});}return;}
    if(message.type==='pong') {if(!wasLive){if(role==='manager')publish();else if(ready)send({type:'sync'});}return;}
    if(role==='manager') {
      if(message.type==='ready') {if(Number.isInteger(message.serial))acknowledged=Math.max(acknowledged,Math.min(message.serial,serial));if(!ready){markReady();status(true);callbacks.onReady?.();}}
      else if(message.type==='sync') publish();
      else if(message.type==='leave') {callbacks.onLeave?.();close();}
      // Observers never get an operation capable of mutating the manager's game.
      return;
    }
    if(message.type==='state') {
      let game;try{game=validateSharedGame(message.game);}catch{return;}
      if(!ready)markReady();status(true);
      callbacks.onState?.(game, typeof message.noticeId==='string' && message.noticeId.length<100 ? message.noticeId : null);
      send({type:'ready',serial:message.serial});
    } else if(message.type==='exit') {callbacks.onExit?.();close();}
  }
  function attach(dc) {
    channel=dc;
    channel.onmessage=receive;
    let opened=false;
    channel.onopen=()=>{
      if(closed||opened)return;opened=true;
      lastSeen=Date.now();
      report('channel-open');
      if(role==='manager')publish();else send({type:'sync'});
      heartbeat=setInterval(()=>{if(Date.now()-lastSeen>15_000)status(false);send({type:'ping'});},3000);
    };
    channel.onclose=()=>{report('channel-closed');status(false);clearInterval(heartbeat);if(!ready)fail('connectionFailed');};
    channel.onerror=()=>{report('channel-error');status(false);if(!ready)fail('connectionFailed');};
    // Some engines deliver the incoming datachannel already open.
    if(channel.readyState==='open')channel.onopen();
  }
  if(role==='manager') attach(pc.createDataChannel('yams-observation',{ordered:true}));
  else pc.ondatachannel=event=>attach(event.channel);
  pc.onconnectionstatechange=()=>{
    report('connection');
    if(['disconnected','failed','closed'].includes(pc.connectionState))status(false);
    if(pc.connectionState==='failed')fail('connectionFailed');
    if(pc.connectionState==='connected' && ready){send({type:'ping'});if(role==='manager')publish();}
  };
  pc.addEventListener('iceconnectionstatechange',()=>{report('ice');if(pc.iceConnectionState==='failed')fail('connectionFailed');});
  pc.addEventListener('icegatheringstatechange',()=>report('gathering'));
  pc.addEventListener('signalingstatechange',()=>report('signaling'));
  function close() {if(closed)return;closed=true;technicalKey=null;clearTimeout(technicalTimer);clearTimeout(deadline);clearTimeout(connectingDeadline);clearInterval(statsTimer);clearInterval(heartbeat);clearTimeout(finishing);channel?.close();pc.close();status(false);}
  return {
    get live(){return live;}, get ready(){return ready;}, get closed(){return closed;},
    diagnostics,
    async offer(){await pc.setLocalDescription(await pc.createOffer());await gatherIce(pc);return encodeSignal({type:'offer',session,expires,sdp:pc.localDescription.sdp});},
    async answer(text){const offer=await decodeSignal(text,'offer');session=offer.session;expires=offer.expires;if(debug)void tagAttempt();await pc.setRemoteDescription({type:'offer',sdp:offer.sdp});await pc.setLocalDescription(await pc.createAnswer());await gatherIce(pc);return encodeSignal({type:'answer',session,expires,sdp:pc.localDescription.sdp});},
    validateAnswer(text){return decodeSignal(text,'answer',session);},
    async acceptAnswer(text){const answer=await decodeSignal(text,'answer',session);await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});report('answer-accepted');if(!ready&&!closed)connectingDeadline=setTimeout(()=>fail('connectionFailed'),45_000);},
    publish, close,
    finish(){
      const until=Date.now()+2000;
      const settle=()=>{if(closed)return;if(acknowledged>=serial || Date.now()>=until)close();else finishing=setTimeout(settle,50);};
      settle();
    },
    leave(){send({type:'leave'});setTimeout(close,300);},
    exit(){send({type:'exit'});setTimeout(close,1000);},
  };
}
