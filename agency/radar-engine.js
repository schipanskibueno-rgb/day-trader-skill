/* The "Radar de Ativos" analysis engine (the same code as the Radar page,
 * https://claude.ai/artifact/WE7tnuyZmu3in4q1JCxetr), so the desk can consult
 * the Radar reading of each chart before an order: more than 20 indicators
 * voting into COMPRA / VENDA / NEUTRO with a strength, plus structure and Dow.
 */
(function(G){
"use strict";
const E={};
function rng(seed){let s=seed>>>0;return function(){s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function gauss(r){let u=0,v=0;while(!u)u=r();while(!v)v=r();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)}
function hash(str){let h=2166136261;for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
E.rng=rng;E.hash=hash;

// f = raiz da fração de um dia que o candle representa (escala da volatilidade)
E.TF={"15m":{min:15,f:0.1},"1h":{min:60,f:0.2},"4h":{min:240,f:0.41},"1D":{min:1440,f:1}};

function pushCandle(s,o){
  const r=s.r,v=s.vol;s.k++;
  const trend=Math.sin(s.k/45+s.phase)*v*0.08+Math.sin(s.k/13+s.phase*2)*v*0.04;
  const z=gauss(r);const ret=s.drift+trend+v*z;
  const c=o*Math.exp(ret);
  const h=Math.max(o,c)*Math.exp(Math.abs(gauss(r))*v*0.45);
  const l=Math.min(o,c)*Math.exp(-Math.abs(gauss(r))*v*0.45);
  const vol=(s.a.baseVol||1000)*(0.6+0.8*r())*(1+Math.abs(z)*0.6);
  s.candles.push({o,h,l,c,v:vol,t:0});return c;
}
E.newSeries=function(a,tf,n,now){
  n=n||600;const T=E.TF[tf];const r=rng(hash(a.tk+"|"+tf));
  const s={a,tf,r,vol:a.vol*T.f,drift:a.drift*T.f*T.f,k:0,phase:r()*6.283,candles:[]};
  let p=100;for(let i=0;i<n;i++)p=pushCandle(s,p);
  const sc=a.ref/s.candles[n-1].c;
  s.candles.forEach(k=>{k.o*=sc;k.h*=sc;k.l*=sc;k.c*=sc});
  const step=T.min*60000;const last=Math.floor((now||Date.now())/step)*step;
  s.candles.forEach((k,i)=>k.t=last-(n-1-i)*step);
  return s;
};
E.step=function(s){const last=s.candles[s.candles.length-1];pushCandle(s,last.c);const nk=s.candles[s.candles.length-1];nk.t=last.t+E.TF[s.tf].min*60000;s.candles.shift()};

// ---------- indicadores (todos causais: o valor em i só usa dados até i) ----------
function sma(x,n){const o=Array(x.length).fill(null);for(let i=n-1;i<x.length;i++){let s=0,ok=true;for(let j=i-n+1;j<=i;j++){if(x[j]==null){ok=false;break}s+=x[j]}if(ok)o[i]=s/n}return o}
function ema(x,n){const o=Array(x.length).fill(null);const k=2/(n+1);let e=null,cnt=0,acc=0;for(let i=0;i<x.length;i++){if(x[i]==null)continue;if(e==null){acc+=x[i];cnt++;if(cnt===n){e=acc/n;o[i]=e}}else{e=x[i]*k+e*(1-k);o[i]=e}}return o}
function rsi(c,n){const o=Array(c.length).fill(null);let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],G=d>0?d:0,L=d<0?-d:0;if(i<=n){g+=G;l+=L;if(i===n){g/=n;l/=n;o[i]=l===0?100:100-100/(1+g/l)}}else{g=(g*(n-1)+G)/n;l=(l*(n-1)+L)/n;o[i]=l===0?100:100-100/(1+g/l)}}return o}
function atrAdx(h,l,c,n){const N=c.length,atr=Array(N).fill(null),adx=Array(N).fill(null),pdi=Array(N).fill(null),ndi=Array(N).fill(null);let str=0,sp=0,sn=0,ax=null;const dxs=[];
  for(let i=1;i<N;i++){const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const up=h[i]-h[i-1],dn=l[i-1]-l[i];const p=up>dn&&up>0?up:0,m=dn>up&&dn>0?dn:0;
    if(i<=n){str+=tr;sp+=p;sn+=m;if(i<n)continue}else{str=str-str/n+tr;sp=sp-sp/n+p;sn=sn-sn/n+m}
    atr[i]=str/n;const P=100*sp/str,M=100*sn/str;pdi[i]=P;ndi[i]=M;const dx=P+M===0?0:100*Math.abs(P-M)/(P+M);
    if(ax==null){dxs.push(dx);if(dxs.length===n){ax=dxs.reduce((a,b)=>a+b,0)/n;adx[i]=ax}}else{ax=(ax*(n-1)+dx)/n;adx[i]=ax}}
  return{atr,adx,pdi,ndi}}
function hl(h,l,i,n){let H=-Infinity,L=Infinity;for(let j=i-n+1;j<=i;j++){if(h[j]>H)H=h[j];if(l[j]<L)L=l[j]}return[H,L]}

E.indicators=function(cs,opt){
  const N=cs.length,c=cs.map(k=>k.c),h=cs.map(k=>k.h),l=cs.map(k=>k.l),v=cs.map(k=>k.v);
  const I={c,h,l,v,sma:{},ema:{},noVol:!!(opt&&opt.noVol)};
  [10,20,50,100,200].forEach(n=>{I.sma[n]=sma(c,n);I.ema[n]=ema(c,n)});
  const e12=ema(c,12),e26=ema(c,26);I.macd=c.map((_,i)=>e26[i]==null?null:e12[i]-e26[i]);I.macdSig=ema(I.macd,9);I.hist=I.macd.map((m,i)=>I.macdSig[i]==null?null:m-I.macdSig[i]);
  I.rsi=rsi(c,14);Object.assign(I,atrAdx(h,l,c,14));
  I.k=Array(N).fill(null);I.wr=Array(N).fill(null);
  for(let i=13;i<N;i++){const[H,L]=hl(h,l,i,14);I.k[i]=H===L?50:100*(c[i]-L)/(H-L);I.wr[i]=H===L?-50:-100*(H-c[i])/(H-L)}
  I.d=sma(I.k,3);
  const tp=cs.map(k=>(k.h+k.l+k.c)/3);I.cci=Array(N).fill(null);
  for(let i=19;i<N;i++){let m=0;for(let j=i-19;j<=i;j++)m+=tp[j];m/=20;let md=0;for(let j=i-19;j<=i;j++)md+=Math.abs(tp[j]-m);md/=20;I.cci[i]=md===0?0:(tp[i]-m)/(0.015*md)}
  I.mfi=Array(N).fill(null);
  for(let i=14;i<N;i++){let pos=0,neg=0;for(let j=i-13;j<=i;j++){const f=tp[j]*v[j];if(tp[j]>tp[j-1])pos+=f;else if(tp[j]<tp[j-1])neg+=f}I.mfi[i]=neg===0?100:100-100/(1+pos/neg)}
  const mfv=cs.map(k=>k.h===k.l?0:((k.c-k.l)-(k.h-k.c))/(k.h-k.l)*k.v);I.cmf=Array(N).fill(null);
  for(let i=19;i<N;i++){let a=0,b=0;for(let j=i-19;j<=i;j++){a+=mfv[j];b+=v[j]}I.cmf[i]=b?a/b:0}
  I.bbM=I.sma[20];I.bbU=Array(N).fill(null);I.bbL=Array(N).fill(null);
  for(let i=19;i<N;i++){const m=I.bbM[i];let s=0;for(let j=i-19;j<=i;j++)s+=(c[j]-m)**2;const sd=Math.sqrt(s/20);I.bbU[i]=m+2*sd;I.bbL[i]=m-2*sd}
  return I;
};

// ---------- votação ----------
// tendência: segue o movimento. osciladores: apontam exageros (reversão à média).
E.votesAt=function(I,i){
  const c=I.c[i],trend=[],osc=[];
  [10,20,50,100,200].forEach(n=>{const s=I.sma[n][i],e=I.ema[n][i];if(s!=null)trend.push({id:"sma"+n,k:"MMS "+n,val:s,price:true,vote:c>s?1:-1});if(e!=null)trend.push({id:"ema"+n,k:"MME "+n,val:e,price:true,vote:c>e?1:-1})});
  if(I.hist[i]!=null)trend.push({id:"macd",k:"MACD (12, 26, 9)",val:I.hist[i],price:true,vote:I.hist[i]>0?1:-1,why:I.hist[i]>0?"Histograma positivo":"Histograma negativo"});
  if(I.adx[i]!=null){const strong=I.adx[i]>=20;trend.push({id:"adx",k:"ADX (14)",val:I.adx[i],extra:{pdi:I.pdi[i],ndi:I.ndi[i]},vote:strong?(I.pdi[i]>I.ndi[i]?1:-1):0,why:strong?(I.pdi[i]>I.ndi[i]?"Tendência com força, +DI na frente":"Tendência com força, −DI na frente"):"Abaixo de 20: sem tendência clara"})}
  if(!I.noVol&&I.cmf[i]!=null)trend.push({id:"cmf",k:"CMF (20)",val:I.cmf[i],vote:I.cmf[i]>0.05?1:I.cmf[i]<-0.05?-1:0,why:I.cmf[i]>0.05?"Fluxo de dinheiro entrando":I.cmf[i]<-0.05?"Fluxo de dinheiro saindo":"Fluxo equilibrado"});
  const R=I.rsi[i];osc.push({id:"rsi",k:"IFR / RSI (14)",val:R,vote:R<30?1:R>70?-1:0,why:R<30?"Sobrevendido":R>70?"Sobrecomprado":"Zona neutra"});
  const K=I.k[i],D=I.d[i];osc.push({id:"stoch",k:"Estocástico (14, 3)",val:K,extra:{d:D},vote:K<20?1:K>80?-1:0,why:K<20?"Sobrevendido":K>80?"Sobrecomprado":"Zona neutra"});
  osc.push({id:"cci",k:"CCI (20)",val:I.cci[i],vote:I.cci[i]<-100?1:I.cci[i]>100?-1:0,why:I.cci[i]<-100?"Muito abaixo da média":I.cci[i]>100?"Muito acima da média":"Perto da média"});
  osc.push({id:"wr",k:"Williams %R (14)",val:I.wr[i],vote:I.wr[i]<-80?1:I.wr[i]>-20?-1:0,why:I.wr[i]<-80?"Sobrevendido":I.wr[i]>-20?"Sobrecomprado":"Zona neutra"});
  if(!I.noVol)osc.push({id:"mfi",k:"MFI (14)",val:I.mfi[i],vote:I.mfi[i]<20?1:I.mfi[i]>80?-1:0,why:I.mfi[i]<20?"Sobrevendido com volume":I.mfi[i]>80?"Sobrecomprado com volume":"Zona neutra"});
  osc.push({id:"bb",k:"Bandas de Bollinger (20, 2)",val:(c-I.bbL[i])/((I.bbU[i]-I.bbL[i])||1),vote:c<I.bbL[i]?1:c>I.bbU[i]?-1:0,why:c<I.bbL[i]?"Abaixo da banda inferior":c>I.bbU[i]?"Acima da banda superior":"Dentro das bandas"});
  return{trend,osc};
};
const avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
E.signalAt=function(I,i){
  const{trend,osc}=E.votesAt(I,i);
  const ts=avg(trend.map(x=>x.vote)),os=avg(osc.map(x=>x.vote));
  let dir=Math.abs(ts)>=0.34?Math.sign(ts):0,st=Math.abs(ts);
  if(dir&&os*dir<0)st-=Math.abs(os)*0.35; // osciladores no extremo contrário tiram força
  if(dir&&I.adx[i]>25)st+=0.08;
  st=Math.max(0,Math.min(1,st));
  if(dir&&st<0.34)dir=0;
  const strong=dir!==0&&st>=0.7;
  const all=trend.concat(osc);
  const counts={buy:all.filter(x=>x.vote>0).length,sell:all.filter(x=>x.vote<0).length,neutral:all.filter(x=>x.vote===0).length,total:all.length};
  return{dir,strong,force:Math.round(st*100),st,ts,os,trend,osc,counts,code:dir>0?(strong?"COMPRA_FORTE":"COMPRA"):dir<0?(strong?"VENDA_FORTE":"VENDA"):"NEUTRO"};
};

// ---------- níveis do sinal (stop e alvos por ATR) ----------
E.levels=function(sig,I){const i=I.c.length-1,e=I.c[i],atr=I.atr[i];
  if(!sig.dir)return{dir:0,entry:e,atr};
  const d=sig.dir,R=1.5*atr;return{dir:d,entry:e,atr,R,stop:e-d*R,tp1:e+d*1.5*R,tp2:e+d*2.5*R,tp3:e+d*3.5*R,rr:2.5}};

// ---------- backtest da regra de sinais no próprio histórico ----------
E.backtest=function(I,cs,H,start){H=H||24;start=start||210;const n=cs.length,trades=[];let prev=0;
  for(let i=start;i<n-1;i++){const d=E.signalAt(I,i).dir;
    if(d!==0&&d!==prev&&i+H<n){const e=I.c[i],R=1.5*I.atr[i],stop=e-d*R,tp=e+d*1.5*R;let res=null;
      for(let j=i+1;j<=i+H;j++){const k=cs[j];const hitS=d>0?k.l<=stop:k.h>=stop,hitT=d>0?k.h>=tp:k.l<=tp;if(hitS){res=-1;break}if(hitT){res=1.5;break}}
      if(res==null)res=(I.c[i+H]-e)*d/R;trades.push({i,d,res})}
    prev=d}
  let eq=0,peak=0,dd=0,gp=0,gl=0;trades.forEach(t=>{eq+=t.res;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);if(t.res>0)gp+=t.res;else gl-=t.res});
  const wins=trades.filter(t=>t.res>0).length;
  return{trades:trades.length,wins,winRate:trades.length?wins/trades.length:0,exp:trades.length?eq/trades.length:0,totalR:eq,maxDD:dd,pf:gl?gp/gl:(gp?Infinity:0),horizon:H,list:trades};
};

// ---------- Monte Carlo (bootstrap dos retornos reais do ativo) ----------
E.monteCarlo=function(I,H,lv,N,seed,perYear){N=N||10000;const c=I.c,n=c.length;const lr=[];for(let i=Math.max(1,n-200);i<n;i++)lr.push(Math.log(c[i]/c[i-1]));
  const mu=avg(lr);for(let j=0;j<lr.length;j++)lr[j]=lr[j]-mu*0.75; // encolhe a tendência média: estimar drift com 200 candles é pouco confiável
  const r=rng(seed);const p0=c[n-1];const ends=new Float64Array(N);let up=0,tp=0,sl=0;const use=lv&&lv.dir;
  const lStop=use?Math.log(lv.stop/p0):0,lTp=use?Math.log(lv.tp1/p0):0;
  for(let s=0;s<N;s++){let lp=0,done=!use;for(let t=0;t<H;t++){lp+=lr[(r()*lr.length)|0];if(!done){if(lv.dir>0?lp<=lStop:lp>=lStop){sl++;done=true}else if(lv.dir>0?lp>=lTp:lp<=lTp){tp++;done=true}}}ends[s]=p0*Math.exp(lp);if(ends[s]>p0)up++}
  const sorted=Array.from(ends).sort((a,b)=>a-b);const q=p=>sorted[Math.min(N-1,Math.floor(p*N))];
  const m=avg(lr),sd=Math.sqrt(avg(lr.map(x=>(x-m)**2)));
  return{N,H,pUp:up/N,p5:q(0.05),p50:q(0.5),p95:q(0.95),pTp:use?tp/N:null,pStop:use?sl/N:null,pNone:use?(N-tp-sl)/N:null,volAnn:sd*Math.sqrt(perYear||252)};
};

// ---------- estrutura de mercado (Smart Money Concepts simplificado) ----------
E.smc=function(cs,I,k){k=k||3;const n=cs.length,sw=[];
  for(let i=k;i<n-k;i++){let isH=true,isL=true;for(let j=i-k;j<=i+k;j++){if(j===i)continue;if(cs[j].h>=cs[i].h)isH=false;if(cs[j].l<=cs[i].l)isL=false}if(isH)sw.push({i,p:cs[i].h,t:"H"});if(isL)sw.push({i,p:cs[i].l,t:"L"})}
  let trend=0,lastH=null,lastL=null,si=0;const ev=[];
  for(let i=0;i<n;i++){while(si<sw.length&&sw[si].i+k<=i){const s=sw[si];if(s.t==="H")lastH={p:s.p,i:s.i,broken:false};else lastL={p:s.p,i:s.i,broken:false};si++}
    const c=cs[i].c;
    if(lastH&&!lastH.broken&&c>lastH.p){lastH.broken=true;ev.push({i,type:trend<0?"CHoCH":"BOS",dir:1,p:lastH.p});trend=1}
    if(lastL&&!lastL.broken&&c<lastL.p){lastL.broken=true;ev.push({i,type:trend>0?"CHoCH":"BOS",dir:-1,p:lastL.p});trend=-1}}
  const highs=sw.filter(s=>s.t==="H"),lows=sw.filter(s=>s.t==="L");
  let structure=0,pattern="Sem topos e fundos suficientes";
  if(highs.length>=2&&lows.length>=2){const[h1,h2]=highs.slice(-2),[l1,l2]=lows.slice(-2);const hh=h2.p>h1.p,hl_=l2.p>l1.p;
    if(hh&&hl_){structure=1;pattern="Topos e fundos ascendentes"}else if(!hh&&!hl_){structure=-1;pattern="Topos e fundos descendentes"}else pattern=hh?"Topo mais alto, mas fundo mais baixo":"Fundo mais alto, mas topo mais baixo"}
  // FVG: lacuna entre a máxima do candle i-2 e a mínima do candle i (ou o inverso) ainda não preenchida
  const fvg=[];const from=Math.max(2,n-150);
  for(let i=from;i<n;i++){
    if(cs[i].l>cs[i-2].h){const lo=cs[i-2].h,hi=cs[i].l;let filled=false;for(let j=i+1;j<n;j++)if(cs[j].l<=lo){filled=true;break}if(!filled)fvg.push({i,dir:1,lo,hi})}
    if(cs[i].h<cs[i-2].l){const lo=cs[i].h,hi=cs[i-2].l;let filled=false;for(let j=i+1;j<n;j++)if(cs[j].h>=hi){filled=true;break}if(!filled)fvg.push({i,dir:-1,lo,hi})}}
  const price=cs[n-1].c,atr=I.atr[n-1];
  const dedupe=(arr)=>{const o=[];arr.forEach(p=>{if(!o.some(x=>Math.abs(x-p)<0.3*atr))o.push(p)});return o};
  const recent=sw.filter(s=>s.i>=n-300);
  const res=dedupe(recent.filter(s=>s.t==="H"&&s.p>price).map(s=>s.p).sort((a,b)=>a-b)).slice(0,2);
  const sup=dedupe(recent.filter(s=>s.t==="L"&&s.p<price).map(s=>s.p).sort((a,b)=>b-a)).slice(0,2);
  fvg.sort((a,b)=>Math.abs((a.lo+a.hi)/2-price)-Math.abs((b.lo+b.hi)/2-price));
  return{swings:sw,events:ev,last:ev[ev.length-1]||null,recentEvents:ev.filter(e=>e.i>=n-100).length,structure,pattern,fvg,sup,res};
};

// ---------- Teoria de Dow ----------
E.dow=function(I,cs){const n=I.c.length,i=n-1,c=I.c[i];
  const ok=p=>I.sma[p][i]!=null&&I.sma[p][i-20]!=null;const primN=ok(200)?200:ok(100)?100:50;
  const s200=I.sma[primN],s50=I.sma[50],s10=I.sma[10];
  const prim=c>s200[i]&&s200[i]>s200[i-20]?1:c<s200[i]&&s200[i]<s200[i-20]?-1:0;
  const sec=c>s50[i]&&s50[i]>s50[i-10]?1:c<s50[i]&&s50[i]<s50[i-10]?-1:0;
  const min=s10[i]>s10[i-3]?1:s10[i]<s10[i-3]?-1:0;
  let upV=0,upN=0,dnV=0,dnN=0;for(let j=n-40;j<n;j++){if(cs[j].c>=cs[j].o){upV+=cs[j].v;upN++}else{dnV+=cs[j].v;dnN++}}
  const ua=upN?upV/upN:0,da=dnN?dnV/dnN:0;
  const volConfirms=(prim===0||I.noVol)?null:(prim>0?ua>da:da>ua);
  return{primN,prim,sec,min,volConfirms,upAvg:ua,dnAvg:da};
};

// ---------- Fibonacci ----------
E.fib=function(cs,look){const n=cs.length;look=Math.min(look||150,n);let hi=-Infinity,lo=Infinity,hiI=0,loI=0;
  for(let i=n-look;i<n;i++){if(cs[i].h>hi){hi=cs[i].h;hiI=i}if(cs[i].l<lo){lo=cs[i].l;loI=i}}
  const upMove=hiI>loI;const R=[0,0.236,0.382,0.5,0.618,0.786,1];
  return{hi,lo,upMove,levels:R.map(r=>({r,p:upMove?hi-(hi-lo)*r:lo+(hi-lo)*r}))};
};

G.RadarEngine=E;
})(typeof window!=="undefined"?window:globalThis);
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.RadarEngine;
