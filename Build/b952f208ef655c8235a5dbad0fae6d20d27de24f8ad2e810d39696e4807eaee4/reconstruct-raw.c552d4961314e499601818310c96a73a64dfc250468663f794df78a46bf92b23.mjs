// Proposed client helper only; not connected to any published loader/entry.
// The recipe is declarative. Public content hashes are integrity, not login/auth.
import {Sha256Stream,digestPart} from './sha256-stream.66c3a569fa1db3f39c07c7a8fb0915c05d639fc207e39745b2bc42aacad63b64.mjs';
const MiB=1024*1024,MAX_RAW=768*MiB,MAX_RECIPE=16*MiB,MAX_OPS=250000;
export const GITHUB_BASE='https://voidverse-studio.github.io/Tale-of-the-Star-Abyss-Pages/';
const HASH=/^[0-9a-f]{64}$/;
const BASE=/^Build\/([0-9a-f]{64})\/StarAbyss-WebGL-WeChat\.data\.part\.([a-z]{2})$/;
const check=(v,m)=>{if(!v)throw Error(m);};
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function identity(x,max){check(x&&integer(x.bytes,1,max)&&HASH.test(x.sha256),'Invalid content identity');}
function keys(value,names){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===names.slice().sort().join(','),'Unexpected recipe fields');}
export function validateRawRecipe(recipe){
  keys(recipe,['schema','output','base','literals','ops']);check(recipe.schema==='starabyss-gzip-raw-ranges-v1','Unsupported recipe schema');
  keys(recipe.output,['bytes','sha256']);identity(recipe.output,MAX_RAW);
  keys(recipe.base,['gzip','raw','parts']);keys(recipe.base.gzip,['bytes','sha256']);keys(recipe.base.raw,['bytes','sha256']);
  identity(recipe.base.gzip,MAX_RAW);identity(recipe.base.raw,MAX_RAW);
  check(Array.isArray(recipe.base.parts)&&recipe.base.parts.length>0&&recipe.base.parts.length<=676,'Invalid base parts');
  const paths=new Set();let sum=0,digest=null;
  for(let i=0;i<recipe.base.parts.length;i++){
    const p=recipe.base.parts[i];keys(p,['path','bytes','sha256']);identity(p,20*MiB);
    const m=typeof p.path==='string'&&p.path.match(BASE);check(m&&!paths.has(p.path),'Unsafe/duplicate base path');paths.add(p.path);
    if(digest===null)digest=m[1];check(m[1]===digest&&m[2]===String.fromCharCode(97+Math.floor(i/26))+String.fromCharCode(97+i%26),'Base order/digest mismatch');sum+=p.bytes;
  }
  check(sum===recipe.base.gzip.bytes,'Base compressed length sum');
  check(Array.isArray(recipe.literals)&&recipe.literals.length<=676,'Invalid literal list');
  for(const p of recipe.literals){
    keys(p,['path','bytes','sha256','rawBytes','rawSha256']);identity(p,20*MiB);identity({bytes:p.rawBytes,sha256:p.rawSha256},16*MiB);
    check(p.path==='Build/'+recipe.output.sha256+'/StarAbyss.raw.literal.'+p.sha256+'.bin'&&!paths.has(p.path),'Unsafe/duplicate literal path');paths.add(p.path);
  }
  check(Array.isArray(recipe.ops)&&recipe.ops.length>0&&recipe.ops.length<=MAX_OPS,'Invalid operation count');
  sum=0;const used=new Set();
  for(const op of recipe.ops){
    check(Array.isArray(op)&&op.length===3,'Invalid range operation');const [source,offset,length]=op;
    check(integer(source,-1,recipe.literals.length-1)&&integer(offset,0,MAX_RAW)&&integer(length,1,MAX_RAW),'Invalid integer range');
    const available=source<0?recipe.base.raw.bytes:recipe.literals[source].rawBytes;
    check(offset<=available&&length<=available-offset,'Range exceeds source bounds');sum+=length;
    check(sum<=recipe.output.bytes,'Range coverage exceeds output');if(source>=0)used.add(source);
  }
  check(sum===recipe.output.bytes&&used.size===recipe.literals.length,'Incomplete output or unused literal');return recipe;
}
function rangesBySource(recipe){
  const jobs=new Map();let destination=0;
  for(const [source,start,length] of recipe.ops){let ranges=jobs.get(source);if(!ranges)jobs.set(source,ranges=[]);ranges.push({start,end:start+length,destination});destination+=length;}
  for(const ranges of jobs.values())ranges.sort((a,b)=>a.start-b.start||a.end-b.end);return jobs;
}
async function copyRawStream(stream,expected,ranges,output,signal){
  const reader=stream.getReader(),hash=new Sha256Stream();let position=0,next=0,active=[];
  try{while(true){
    if(signal?.aborted)throw Error('Data reconstruction cancelled');
    const {done,value}=await reader.read();if(done)break;
    check(value instanceof Uint8Array&&position+value.length<=expected.bytes,'Decoded stream exceeds declared length');
    hash.update(value);const end=position+value.length;
    while(next<ranges.length&&ranges[next].start<end)active.push(ranges[next++]);
    active=active.filter(r=>r.end>position);
    for(const r of active){const from=Math.max(position,r.start),until=Math.min(end,r.end);if(until>from)output.set(value.subarray(from-position,until-position),r.destination+from-r.start);}
    position=end;
  }}catch(error){await reader.cancel(error).catch(()=>{});throw error;}finally{reader.releaseLock();}
  check(position===expected.bytes&&hash.hex()===expected.sha256,'Decoded stream hash/length mismatch');
  check(next===ranges.length,'Unapplied ranges');
}
function decodedBase(parts,expected,readSource,Decompressor,signal,onProgress){
  const hash=new Sha256Stream();let next=0,total=0;
  return new ReadableStream({async pull(controller){
    try{
      if(signal?.aborted)throw Error('Data reconstruction cancelled');
      if(next===parts.length){check(total===expected.bytes&&hash.hex()===expected.sha256,'Full base gzip mismatch');controller.close();return;}
      const part=parts[next],bytes=await readSource(part,signal);
      check(bytes instanceof Uint8Array&&bytes.length===part.bytes&&await digestPart(bytes)===part.sha256,'Base part hash/length mismatch');
      hash.update(bytes);total+=bytes.length;next++;controller.enqueue(bytes);onProgress({phase:'base',part:next,parts:parts.length});
    }catch(error){controller.error(error);}
  }}).pipeThrough(new Decompressor('gzip'));
}
export async function reconstructRawArchive(recipeBytes,{recipeSha256,expectedOutput,readSource,signal,onProgress=()=>{},Decompressor=globalThis.DecompressionStream}={}){
  check(recipeBytes instanceof Uint8Array&&recipeBytes.length>0&&recipeBytes.length<=MAX_RECIPE&&HASH.test(recipeSha256),'Invalid recipe input');
  check(await digestPart(recipeBytes)===recipeSha256,'Recipe hash mismatch');
  const recipe=validateRawRecipe(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(recipeBytes)));
  identity(expectedOutput,MAX_RAW);check(recipe.output.bytes===expectedOutput.bytes&&recipe.output.sha256===expectedOutput.sha256,'Unexpected target archive');
  check(typeof readSource==='function'&&typeof Decompressor==='function','Streaming gzip decoding is not available on this browser');
  const jobs=rangesBySource(recipe),output=new Uint8Array(recipe.output.bytes);
  if(jobs.has(-1))await copyRawStream(decodedBase(recipe.base.parts,recipe.base.gzip,readSource,Decompressor,signal,onProgress),recipe.base.raw,jobs.get(-1),output,signal);
  for(let i=0;i<recipe.literals.length;i++){
    const literal=recipe.literals[i],bytes=await readSource(literal,signal);
    check(bytes instanceof Uint8Array&&bytes.length===literal.bytes&&await digestPart(bytes)===literal.sha256,'Literal gzip hash/length mismatch');
    const stream=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}).pipeThrough(new Decompressor('gzip'));
    await copyRawStream(stream,{bytes:literal.rawBytes,sha256:literal.rawSha256},jobs.get(i),output,signal);onProgress({phase:'literal',part:i+1,parts:recipe.literals.length});
  }
  check(new Sha256Stream().update(output).hex()===recipe.output.sha256,'Reconstructed archive hash mismatch');
  check(new TextDecoder().decode(output.subarray(0,16))==='UnityWebData1.0\0','Reconstructed Unity archive marker');
  onProgress({phase:'complete',bytes:output.length});return output;
}

export function createPublicAssetReader({baseUrl=GITHUB_BASE,fetchImpl=globalThis.fetch,allowLocalPreview=false}={}){
  const base=new URL(baseUrl);
  const local=allowLocalPreview&&['127.0.0.1','localhost'].includes(base.hostname)&&['http:','https:'].includes(base.protocol)&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname.endsWith('/');
  check(baseUrl===GITHUB_BASE||local,'Unexpected publication origin');
  return async function readSource(file,signal){
    check(typeof file.path==='string'&&/^Build\/[0-9a-f]{64}\/[A-Za-z0-9.-]+$/.test(file.path),'Unsafe request path');
    identity(file,20*MiB);const url=new URL(file.path,baseUrl).href;
    const controller=new AbortController(),cancel=()=>controller.abort(signal?.reason),timer=setTimeout(()=>controller.abort(),60000);
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
    try{
    const response=await fetchImpl(url,{signal:controller.signal,redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',mode:'same-origin',cache:'force-cache'});
    check(response.ok&&!response.redirected&&(!response.url||response.url===url),'Public asset request failed or redirected');
    const length=response.headers?.get('Content-Length');if(length!==null&&length!==undefined)check(/^\d+$/.test(length)&&Number(length)===file.bytes,'Response declared length mismatch');
    check(response.body&&typeof response.body.getReader==='function','Streamed response body required');
    const data=new Uint8Array(file.bytes),reader=response.body.getReader();let used=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;check(value instanceof Uint8Array&&value.length<=data.length-used,'Response exceeds expected length');data.set(value,used);used+=value.length;}}
    catch(error){await reader.cancel(error).catch(()=>{});throw error;}finally{reader.releaseLock();}
    check(used===data.length,'Truncated public asset');return data;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  };
}
