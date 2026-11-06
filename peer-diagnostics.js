// Test-only module. Raw descriptions and the random session salt stay on-device.
const scopeKeys=['privateIpv4','sharedIpv4','publicIpv4','loopback','linkLocal','uniqueLocalIpv6','publicIpv6','mdns','unspecified','unknown'];
function addressScope(address) {
  const value=address.toLowerCase();
  if(value.endsWith('.local'))return 'mdns';
  if(value==='::'||value==='0.0.0.0')return 'unspecified';
  if(value==='::1')return 'loopback';
  const bytes=value.split('.').map(Number);
  if(bytes.length===4 && bytes.every(n=>Number.isInteger(n)&&n>=0&&n<=255)) {
    if(bytes[0]===127)return 'loopback';
    if(bytes[0]===169&&bytes[1]===254)return 'linkLocal';
    if(bytes[0]===10||bytes[0]===172&&bytes[1]>=16&&bytes[1]<=31||bytes[0]===192&&bytes[1]===168)return 'privateIpv4';
    if(bytes[0]===100&&bytes[1]>=64&&bytes[1]<=127)return 'sharedIpv4';
    return 'publicIpv4';
  }
  if(value.includes(':')) {
    if(/^fe[89ab]/.test(value))return 'linkLocal';
    if(/^f[cd]/.test(value))return 'uniqueLocalIpv6';
    return 'publicIpv6';
  }
  return 'unknown';
}
const lines=sdp=>String(sdp??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
async function tag(salt,kind,value) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${salt}\0yams-diag-${kind}\0${value}`));
  return [...new Uint8Array(bytes)].slice(0,16).map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function describe(sdp,salt) {
  if(!sdp)return null;
  const all=lines(sdp),candidates=all.filter(line=>line.startsWith('a=candidate:')).map(line=>line.replace(/\s+/g,' ')).sort();
  const scopes=Object.fromEntries(scopeKeys.map(key=>[key,0])),prefixes=new Set();let zeroPorts=0;
  for(const line of candidates) {
    const fields=line.split(' '),address=fields[4]??'',scope=addressScope(address);scopes[scope]++;
    if(scope==='privateIpv4')prefixes.add(address.split('.').slice(0,3).join('.'));
    if(fields[5]==='0')zeroPorts++;
  }
  const credentials=all.filter(line=>/^a=ice-(ufrag|pwd):/.test(line)).sort().join('\n');
  const [descriptionTag,credentialsTag,candidatesTag,privatePrefixTags]=await Promise.all([
    tag(salt,'description',all.sort().join('\n')),tag(salt,'credentials',credentials),tag(salt,'candidates',candidates.join('\n')),
    Promise.all([...prefixes].slice(0,16).map(prefix=>tag(salt,'private-prefix-24',prefix))),
  ]);
  return {descriptionTag,credentialsTag,candidatesTag,privatePrefixTags:privatePrefixTags.sort(),scopes,zeroPorts};
}

export async function describeTransport(localSdp,remoteSdp,salt) {
  const [local,remote]=await Promise.all([describe(localSdp,salt),describe(remoteSdp,salt)]);
  return {available:true,local,remote,sharedPrivatePrefix24:local&&remote?local.privatePrefixTags.filter(value=>remote.privatePrefixTags.includes(value)).length:null};
}

export async function readEnvironment(nav=globalThis.navigator) {
  async function permission(name) {
    if(!nav?.permissions?.query)return 'unsupported';
    let timer;
    try {
      const result=await Promise.race([nav.permissions.query({name}),new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'unavailable'}),1000);})]);
      return ['granted','denied','prompt'].includes(result.state)?result.state:'unavailable';
    } catch {return 'unsupported';} finally {clearTimeout(timer);}
  }
  const [localNetwork,loopbackNetwork,legacyLocalNetwork,camera]=await Promise.all(['local-network','loopback-network','local-network-access','camera'].map(permission));
  return {localNetwork,loopbackNetwork,legacyLocalNetwork,camera,secureContext:globalThis.isSecureContext===true,
    visibility:['visible','hidden'].includes(globalThis.document?.visibilityState)?document.visibilityState:'unknown'};
}

// Two isolated peers, the real app protocol and no camera, storage or server.
export async function runLocalPeerTest(createPeer,{timeoutMs=25000}={}) {
  const started=Date.now();let manager,observer,timer,settled=false;
  let managerDetails=null,observerDetails=null;
  let finish;
  const completed=new Promise(resolve=>{finish=(result,failure=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({result,failure});};});
  timer=setTimeout(()=>finish('failed','timeout'),timeoutMs);
  const fixture={id:'internal-diagnostic',format:'order',status:'active',basePlayers:[{id:'0',name:'Diagnostic'}],timeline:{cursor:0,events:[]}};
  try {
    manager=createPeer('manager',{getState:()=>fixture,onReady:()=>finish('passed'),onError:code=>finish('failed',code),onDiagnostics:details=>{managerDetails=details;}});
    observer=createPeer('observer',{onState:game=>{if(game.id!=='internal-diagnostic')finish('failed','stateMismatch');},onError:code=>finish('failed',code),onDiagnostics:details=>{observerDetails=details;}});
    // Also bound unsupported/stalled setup: race each async step with completion.
    const step=async promise=>Promise.race([promise,completed.then(()=>{throw Error('test-settled');})]);
    const offer=await step(manager.offer());const answer=await step(observer.answer(offer));await step(manager.acceptAnswer(answer));
    const outcome=await completed;
    return {...outcome,durationMs:Date.now()-started,manager:summary(managerDetails),observer:summary(observerDetails)};
  } catch(error) {
    finish('failed',['unsupported','pairError','connectionFailed'].includes(error.message)?error.message:'setup');
    const outcome=await completed;
    return {...outcome,durationMs:Date.now()-started,manager:summary(managerDetails),observer:summary(observerDetails)};
  } finally {clearTimeout(timer);manager?.close();observer?.close();}
}
function summary(details) {
  if(!details)return null;
  return {ready:details.ready,ice:details.ice,connection:details.connection,channel:details.channel,
    local:details.local,remote:details.remote,connectivity:details.connectivity};
}
