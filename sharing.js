import { CATEGORIES, GAME_FORMATS, columnsForFormat, gameFormat, emptyPlayer, isCellPlayable, validateScore, isGameComplete } from './scoring.js';

const SIGNAL_TTL = 5 * 60_000;
const MAX_MESSAGE = 64_000;
const MAX_SIGNAL = 16_000;

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

export function createPeer(role, callbacks = {}) {
  if(!globalThis.RTCPeerConnection) throw Error('unsupported');
  // No default public STUN, TURN or signalling service, including in dependencies.
  const pc=new RTCPeerConnection({iceServers:[],iceCandidatePoolSize:0,bundlePolicy:'max-bundle'});
  let channel, session=crypto.randomUUID(), expires=Date.now()+SIGNAL_TTL;
  let closed=false, live=false, lastSeen=Date.now(), heartbeat=null, ready=false;
  let serial=0, acknowledged=0, finishing=null;
  const deadline=setTimeout(()=>{if(!ready){callbacks.onError?.('pairError');close();}},SIGNAL_TTL);
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
      if(message.type==='ready') {if(Number.isInteger(message.serial))acknowledged=Math.max(acknowledged,Math.min(message.serial,serial));if(!ready){ready=true;clearTimeout(deadline);status(true);callbacks.onReady?.();}}
      else if(message.type==='sync') publish();
      else if(message.type==='leave') {callbacks.onLeave?.();close();}
      // Observers never get an operation capable of mutating the manager's game.
      return;
    }
    if(message.type==='state') {
      let game;try{game=validateSharedGame(message.game);}catch{return;}
      ready=true;clearTimeout(deadline);status(true);
      callbacks.onState?.(game, typeof message.noticeId==='string' && message.noticeId.length<100 ? message.noticeId : null);
      send({type:'ready',serial:message.serial});
    } else if(message.type==='exit') {callbacks.onExit?.();close();}
  }
  function attach(dc) {
    channel=dc;
    channel.onmessage=receive;
    channel.onopen=()=>{
      if(closed)return;
      lastSeen=Date.now();
      if(role==='manager')publish();
      heartbeat=setInterval(()=>{if(Date.now()-lastSeen>15_000)status(false);send({type:'ping'});},3000);
    };
    channel.onclose=()=>{status(false);clearInterval(heartbeat);};
    channel.onerror=()=>status(false);
  }
  if(role==='manager') attach(pc.createDataChannel('yams-observation',{ordered:true}));
  else pc.ondatachannel=event=>attach(event.channel);
  pc.onconnectionstatechange=()=>{
    if(['disconnected','failed','closed'].includes(pc.connectionState))status(false);
    if(pc.connectionState==='connected' && ready){send({type:'ping'});if(role==='manager')publish();}
  };
  function close() {if(closed)return;closed=true;clearTimeout(deadline);clearInterval(heartbeat);clearTimeout(finishing);channel?.close();pc.close();status(false);}
  return {
    get live(){return live;}, get ready(){return ready;}, get closed(){return closed;},
    async offer(){await pc.setLocalDescription(await pc.createOffer());await gatherIce(pc);return encodeSignal({type:'offer',session,expires,sdp:pc.localDescription.sdp});},
    async answer(text){const offer=await decodeSignal(text,'offer');session=offer.session;expires=offer.expires;await pc.setRemoteDescription({type:'offer',sdp:offer.sdp});await pc.setLocalDescription(await pc.createAnswer());await gatherIce(pc);return encodeSignal({type:'answer',session,expires,sdp:pc.localDescription.sdp});},
    validateAnswer(text){return decodeSignal(text,'answer',session);},
    async acceptAnswer(text){const answer=await decodeSignal(text,'answer',session);await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});},
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
