/* Sandbox Node shim — lets the real server source run inside a browser-like
   sandbox for validation. NOT part of the application; the supported path is
   `node tests/run.js`. Exists so the validation pass is reproducible. */
(function () {
function sha256Hex(msg) {
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes=new TextEncoder().encode(msg);
  const l=bytes.length; const padLen=((l+1+8+63)>>6)<<6;
  const buf=new Uint8Array(padLen); buf.set(bytes); buf[l]=0x80;
  const bits=l*8; const dvp=new DataView(buf.buffer);
  dvp.setUint32(padLen-4,bits>>>0); dvp.setUint32(padLen-8,Math.floor(bits/4294967296));
  const w=new Uint32Array(64); const dv=new DataView(buf.buffer);
  const rr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let i=0;i<padLen;i+=64){
    for(let t=0;t<16;t++) w[t]=dv.getUint32(i+t*4);
    for(let t=16;t<64;t++){const s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3);const s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;}
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for(let t=0;t<64;t++){
      const S1=rr(e,6)^rr(e,11)^rr(e,25); const ch=(e&f)^(~e&g);
      const t1=(h+S1+ch+K[t]+w[t])>>>0;
      const S0=rr(a,2)^rr(a,13)^rr(a,22); const mj=(a&b)^(a&c)^(b&c);
      const t2=(S0+mj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H=[(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
  }
  return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
function hexToBin(h){ let s=''; for(let i=0;i<h.length;i+=2) s+=String.fromCharCode(parseInt(h.substr(i,2),16)); return s; }
const b64={enc:(s)=>btoa(unescape(encodeURIComponent(s))),dec:(s)=>decodeURIComponent(escape(atob(s)))};
class Buf {
  constructor(str){ this.s=str; }
  static from(x,enc){
    if (x instanceof Uint8Array){ let s=''; x.forEach(b=>s+=String.fromCharCode(b)); return new Buf(s); }
    if (enc==='base64url') return new Buf(b64.dec(String(x).replace(/-/g,'+').replace(/_/g,'/')));
    return new Buf(String(x));
  }
  static byteLength(s){ return new TextEncoder().encode(String(s)).length; }
  toString(enc){
    if (enc==='base64url') return b64.enc(this.s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    if (enc==='hex'){ let o=''; for(let i=0;i<this.s.length;i++) o+=this.s.charCodeAt(i).toString(16).padStart(2,'0'); return o; }
    return this.s;
  }
  readUInt32BE(off){ let v=0; for(let i=0;i<4;i++) v=(v*256)+(this.s.charCodeAt(off+i)&0xff); return v; }
}
const FILES={};
const fsShim={
  readFileSync(p){ if(FILES[p]===undefined){const e=new Error('ENOENT '+p); e.code='ENOENT'; throw e;} return FILES[p]; },
  writeFileSync(p,d){ FILES[p]=String(d); },
  writeFile(p,d,cb){ FILES[p]=String(d); if(cb)cb(null); },
  existsSync(p){ return FILES[p]!==undefined; },
  mkdirSync(){}, rmSync(p){ delete FILES[p]; }, unlinkSync(p){ delete FILES[p]; },
  readdirSync(){ return []; },
  createWriteStream(p){ if(FILES[p]===undefined) FILES[p]=''; return { write(d,cb){ FILES[p]+=d; if(cb)cb(null); }, on(){} }; },
  readFile(p,cb){ cb(FILES[p]===undefined?new Error('ENOENT'):null, FILES[p]); }
};
const pathShim={
  sep:'/',
  join(...a){ return a.filter(Boolean).join('/').replace(/\/+/g,'/'); },
  normalize(p){ const parts=[]; String(p).split('/').forEach(s=>{ if(s==='.'||s==='')return; if(s==='..')parts.pop(); else parts.push(s); }); return (String(p).startsWith('/')?'/':'')+parts.join('/'); },
  dirname(p){ return String(p).split('/').slice(0,-1).join('/')||'.'; },
  extname(p){ const b=String(p).split('/').pop(); const i=b.lastIndexOf('.'); return i<=0?'':b.slice(i); },
  isAbsolute(p){ return String(p).startsWith('/'); },
  resolve(...a){ return pathShim.normalize(a.join('/')); }
};
const cryptoShim={
  createHash(){ let data=''; return { update(d){ data+=d; return this; },
    digest(enc){ const hex=sha256Hex(data); return enc==='hex'?hex:Buf.from(hexToBin(hex)); } }; },
  randomBytes(n){ let s=''; for(let i=0;i<n;i++) s+=String.fromCharCode(Math.floor(Math.random()*256)); return Buf.from(s); }
};
const captured={};
const httpShim={ createServer(handler){
  captured.handler=handler;               /* set synchronously at module load */
  return { listen(port,cb){
    captured.port=port;
    captured.listening=true;              /* the real "accepting requests" signal */
    captured.listenedAt=Date.now();
    if(cb)cb(); return this;
  }, close(){ captured.closed=true; captured.listening=false; } };
} };
const BUILTINS={ fs:fsShim, path:pathShim, crypto:cryptoShim, http:httpShim, os:{tmpdir:()=>'/tmp'} };

function makeLoader(sources, env) {
  const cache={};
  function resolveId(from, req){
    if (BUILTINS[req]) return req;
    const base = from ? from.split('/').slice(0,-1).join('/') : '';
    const p = pathShim.normalize((base?base+'/':'')+req);
    if (sources[p]!==undefined) return p;
    if (sources[p+'.js']!==undefined) return p+'.js';
    throw new Error('Cannot resolve "'+req+'" from "'+from+'"');
  }
  function load(id, fromId){
    if (BUILTINS[id]) return BUILTINS[id];
    const rid = resolveId(fromId, id);
    if (BUILTINS[rid]) return BUILTINS[rid];
    if (cache[rid]) return cache[rid].exports;
    const mod={exports:{}};
    cache[rid]=mod;
    /* strip a shebang: Node removes it before compiling, new Function does not */
    const src = String(sources[rid]).replace(/^#![^\n]*\n/, '');
    const fn=new Function('exports','require','module','__dirname','__filename','Buffer','process','setInterval','console',
      src+'\n');
    const si=()=>{ const t={unref(){return t;}}; return t; };
    const proc = { env: env, argv: (globalThis.process && globalThis.process.argv) || ['node', rid], on(){}, exit(){}, platform:'linux' };
    fn(mod.exports,(r)=>load(r,rid),mod,rid.split('/').slice(0,-1).join('/'),rid,Buf,proc,si,console);
    return mod.exports;
  }
  return load;
}

/* Drive a request through the captured http handler. */
function request(method, path, body, token) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { host:'localhost:4123', 'content-type':'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    const listeners = {};
    const req = {
      method: method, url: path, headers: headers,
      socket: { remoteAddress: '127.0.0.1' },
      on(ev, fn){ (listeners[ev]=listeners[ev]||[]).push(fn); return req; },
      destroy(){}
    };
    let status=null, chunks=[], headersSent=false;
    const res = {
      get headersSent(){ return headersSent; },
      writeHead(code){ status=code; headersSent=true; return res; },
      write(d){ chunks.push(String(d)); return true; },
      end(d){ if(d!==undefined) chunks.push(String(d));
        const raw = chunks.join('');
        let parsed=null; try{ parsed=JSON.parse(raw); }catch(e){ parsed=raw; }
        resolve({ status: status, body: parsed, raw: raw });
      }
    };
    captured.handler(req, res);
    setTimeout(()=>{
      (listeners.data||[]).forEach(f=>{ if(payload) f(payload); });
      (listeners.end||[]).forEach(f=>f());
    }, 0);
  });
}

globalThis.__TMH = { makeLoader, request, captured, FILES, Buf, fsShim, pathShim, cryptoShim, sha256Hex, BUILTINS };
})();
