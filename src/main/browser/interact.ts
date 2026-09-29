/**
 * DOM-level interaction scripts for the MCP browser tools.
 *
 * Each builder returns an IIFE string for `webContents.executeJavaScript`
 * (same contract as buildSnapshotScript: string in, JSON-string out).
 *
 * Preferred path for click/type/key is CDP Input (see cdp-input.ts) with
 * these scripts providing: ref resolution + scrollIntoView, DOM fallback
 * when the debugger cannot attach, and helpers for fill / select / scroll
 * that still need DOM APIs. The operator-facing pointer is drawn by the
 * renderer over the webview (see BrowserPointerEvent), not injected into
 * the guest page — page CSP would hide an in-page cursor.
 *
 * Refs come from the most recent browser_snapshot (`data-dt-ref` attributes),
 * so every script starts by resolving its element and returns a structured
 * error when the page has moved on.
 */

export interface InteractionOutcome {
  ok?: boolean
  detail?: string
  passwordField?: boolean
  err?: string
  /** Viewport coords after scrollIntoView (for CDP Input). */
  x?: number
  y?: number
  /** Guest layout viewport, so the overlay can map x/y onto the webview box. */
  vw?: number
  vh?: number
  tag?: string
  role?: string
  name?: string
  value?: string
  scrollX?: number
  scrollY?: number
}

/** Parse a guest script's stringified result; never throws. */
export function parseInteraction(raw: unknown): InteractionOutcome {
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj && typeof obj === 'object' ? (obj as InteractionOutcome) : { err: 'no result' }
  } catch {
    return { err: 'unparseable guest result' }
  }
}

export function staleRefError(ref: string): string {
  return (
    `ref ${ref} no longer exists — the page changed since your last snapshot; ` +
    `run browser_snapshot again, then retry with the new ref`
  )
}

function resolvePrelude(ref: string): string {
  const missing = JSON.stringify({ err: staleRefError(ref) })
  return `var el=document.querySelector('[data-dt-ref=${JSON.stringify(ref)}]');
if(!el)return ${missing};
try{el.scrollIntoView({block:'center',behavior:'instant'})}catch(_e){}`
}

function accessibleNameExpr(): string {
  return `(el.getAttribute('aria-label')||(el.tagName==='INPUT'&&(el.placeholder||el.name))||el.getAttribute('alt')||el.getAttribute('title')||(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim()||'').slice(0,120)`
}

/**
 * Resolve a snapshot ref: scroll into view and return viewport coordinates
 * for CDP Input. Does not click. The visible pointer is a renderer overlay.
 */
export function buildResolveRefScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var r=el.getBoundingClientRect();
var x=r.left+r.width/2,y=r.top+r.height/2;
try{el.focus({preventScroll:true})}catch(_e){}
return JSON.stringify({ok:true,x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0,tag:(el.tagName||'').toLowerCase(),role:(el.getAttribute('role')||''),name:${accessibleNameExpr()}});
})()`
}

export function buildClickScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var r=el.getBoundingClientRect();
var x=r.left+r.width/2,y=r.top+r.height/2;
var opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y};
try{el.focus({preventScroll:true})}catch(_e){}
if(typeof PointerEvent==='function'){el.dispatchEvent(new PointerEvent('pointerdown',opts));el.dispatchEvent(new PointerEvent('pointerup',opts))}
el.dispatchEvent(new MouseEvent('mousedown',opts));
el.dispatchEvent(new MouseEvent('mouseup',opts));
el.click();
return JSON.stringify({ok:true,detail:(el.tagName||'').toLowerCase()+(el.innerText?(' "'+String(el.innerText).slice(0,60)+'"'):''),x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0})
})()`
}

export function buildHoverScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var r=el.getBoundingClientRect();
var x=r.left+r.width/2,y=r.top+r.height/2;
var opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y};
el.dispatchEvent(new MouseEvent('mouseover',opts));
el.dispatchEvent(new MouseEvent('mouseenter',opts));
el.dispatchEvent(new MouseEvent('mousemove',opts));
return JSON.stringify({ok:true,detail:'hovered '+(el.tagName||'').toLowerCase(),x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0})
})()`
}

export function buildTypeScript(
  ref: string,
  text: string,
  submit: boolean,
  allowPassword = false
): string {
  return `(function(){
${resolvePrelude(ref)}
var isPwd=(el.tagName==='INPUT'&&String(el.type).toLowerCase()==='password');
if(isPwd&&!${allowPassword})return JSON.stringify({passwordField:true});
var r=el.getBoundingClientRect();
var x=r.left+Math.min(24,r.width/2),y=r.top+r.height/2;
var next=${JSON.stringify(text)};
if(el.isContentEditable){el.textContent=next;}
else{
var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
var desc=Object.getOwnPropertyDescriptor(proto,'value');
if(!desc||!desc.set)return JSON.stringify({err:'element has no settable value'});
try{el.focus({preventScroll:true})}catch(_e){}
desc.set.call(el,next);
el.dispatchEvent(new Event('input',{bubbles:true}));
el.dispatchEvent(new Event('change',{bubbles:true}));
}
${
  submit
    ? `var form=el.closest('form');
if(form&&typeof form.requestSubmit==='function'){form.requestSubmit();return JSON.stringify({ok:true,detail:'typed + submitted form'})}
['keydown','keypress','keyup'].forEach(function(ty){el.dispatchEvent(new KeyboardEvent(ty,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))});`
    : ''
}
return JSON.stringify({ok:true,detail:'typed',x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0,value:String(el.value||el.textContent||'').slice(0,80)})
})()`
}

/**
 * Clear + set value via native setters (React-safe). Used as CDP fill
 * prelude (focus/select-all) and as full DOM fallback.
 */
export function buildFillScript(
  ref: string,
  text: string,
  submit: boolean,
  allowPassword = false,
  mode: 'full' | 'prepare' = 'full'
): string {
  return `(function(){
${resolvePrelude(ref)}
var isPwd=(el.tagName==='INPUT'&&String(el.type).toLowerCase()==='password');
if(isPwd&&!${allowPassword})return JSON.stringify({passwordField:true});
var r=el.getBoundingClientRect();
var x=r.left+Math.min(24,r.width/2),y=r.top+r.height/2;
try{el.focus({preventScroll:true})}catch(_e){}
var next=${JSON.stringify(text)};
if(el.isContentEditable){
  if(${JSON.stringify(mode)}==='prepare'){
    document.execCommand('selectAll',false,null);
    return JSON.stringify({ok:true,x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0,tag:'contenteditable',detail:'prepared'})
  }
  el.textContent=next;
  el.dispatchEvent(new Event('input',{bubbles:true}));
}else{
  var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
  var desc=Object.getOwnPropertyDescriptor(proto,'value');
  if(!desc||!desc.set)return JSON.stringify({err:'element has no settable value'});
  if(${JSON.stringify(mode)}==='prepare'){
    desc.set.call(el,'');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    try{el.select()}catch(_e){}
    return JSON.stringify({ok:true,x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0,tag:(el.tagName||'').toLowerCase(),detail:'prepared'})
  }
  desc.set.call(el,next);
  el.dispatchEvent(new Event('input',{bubbles:true}));
  el.dispatchEvent(new Event('change',{bubbles:true}));
}
${
  submit
    ? `var form=el.closest('form');
if(form&&typeof form.requestSubmit==='function'){form.requestSubmit();return JSON.stringify({ok:true,detail:'filled + submitted',value:String(el.value||el.textContent||'').slice(0,80)})}
['keydown','keypress','keyup'].forEach(function(ty){el.dispatchEvent(new KeyboardEvent(ty,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))});`
    : ''
}
return JSON.stringify({ok:true,detail:'filled',x:x,y:y,vw:window.innerWidth||0,vh:window.innerHeight||0,value:String(el.value||el.textContent||'').slice(0,80)})
})()`
}

export function buildSelectScript(
  ref: string,
  opts: { value?: string; label?: string; index?: number }
): string {
  const value = opts.value !== undefined ? JSON.stringify(opts.value) : 'null'
  const label = opts.label !== undefined ? JSON.stringify(opts.label) : 'null'
  const index = opts.index !== undefined ? String(opts.index) : 'null'
  return `(function(){
${resolvePrelude(ref)}
var wantValue=${value},wantLabel=${label},wantIndex=${index};
if((el.tagName||'').toLowerCase()!=='select'){
  return JSON.stringify({err:'ref is not a native <select> — use browser_click on the combobox/option refs instead',tag:(el.tagName||'').toLowerCase()});
}
var opts=el.options||[];
var chosen=-1;
if(wantIndex!==null&&wantIndex>=0&&wantIndex<opts.length)chosen=wantIndex;
else if(wantValue!==null){for(var i=0;i<opts.length;i++){if(String(opts[i].value)===String(wantValue)){chosen=i;break}}}
else if(wantLabel!==null){for(var j=0;j<opts.length;j++){if(String(opts[j].text).trim()===String(wantLabel).trim()){chosen=j;break}}}
if(chosen<0)return JSON.stringify({err:'no matching option (value/label/index)'});
el.selectedIndex=chosen;
try{el.focus({preventScroll:true})}catch(_e){}
el.dispatchEvent(new Event('input',{bubbles:true}));
el.dispatchEvent(new Event('change',{bubbles:true}));
var o=opts[chosen];
var r=el.getBoundingClientRect();
return JSON.stringify({ok:true,detail:'selected "'+String(o.text).slice(0,80)+'"',value:String(o.value),x:r.left+r.width/2,y:r.top+r.height/2,vw:window.innerWidth||0,vh:window.innerHeight||0})
})()`
}

export function buildScrollScript(opts: {
  ref?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  pixels?: number
}): string {
  const dir = JSON.stringify(opts.direction ?? 'down')
  const px = Math.max(1, Math.min(10000, opts.pixels ?? 600))
  const ref = opts.ref
  if (ref) {
    return `(function(){
${resolvePrelude(ref)}
var dir=${dir},px=${px};
var dx=0,dy=0;
if(dir==='down')dy=px;else if(dir==='up')dy=-px;else if(dir==='right')dx=px;else if(dir==='left')dx=-px;
if(el===document.body||el===document.documentElement){window.scrollBy(dx,dy)}
else{el.scrollBy(dx,dy)}
var r=el.getBoundingClientRect();
return JSON.stringify({ok:true,detail:'scrolled '+dir+' '+px+'px',scrollX:window.scrollX,scrollY:window.scrollY,x:r.left+r.width/2,y:r.top+r.height/2,vw:window.innerWidth||0,vh:window.innerHeight||0})
})()`
  }
  return `(function(){
var dir=${dir},px=${px};
var dx=0,dy=0;
if(dir==='down')dy=px;else if(dir==='up')dy=-px;else if(dir==='right')dx=px;else if(dir==='left')dx=-px;
window.scrollBy(dx,dy);
return JSON.stringify({ok:true,detail:'scrolled page '+dir+' '+px+'px',scrollX:window.scrollX,scrollY:window.scrollY,x:window.innerWidth/2,y:window.innerHeight/2,vw:window.innerWidth||0,vh:window.innerHeight||0})
})()`
}

export function buildKeyPressScript(key: string, ref?: string): string {
  const k = JSON.stringify(String(key).slice(0, 48))
  if (ref) {
    return `(function(){
${resolvePrelude(ref)}
try{el.focus({preventScroll:true})}catch(_e){}
var target=el;
['keydown','keypress','keyup'].forEach(function(ty){
try{target.dispatchEvent(new KeyboardEvent(ty,{key:${k},code:${k},bubbles:true,cancelable:true}))}catch(_e){}});
return JSON.stringify({ok:true,detail:'sent '+${k}+' to ref'})
})()`
  }
  return `(function(){
var target=document.activeElement||document.body;
if(!target)target=document.body;
['keydown','keypress','keyup'].forEach(function(ty){
try{target.dispatchEvent(new KeyboardEvent(ty,{key:${k},code:${k},bubbles:true,cancelable:true}))}catch(_e){}});
return JSON.stringify({ok:true,detail:'sent '+${k}})})()`
}

/** Probe whether a password field sits at this ref (no mutation). */
export function buildPasswordProbeScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var isPwd=(el.tagName==='INPUT'&&String(el.type).toLowerCase()==='password');
return JSON.stringify({ok:true,passwordField:!!isPwd,tag:(el.tagName||'').toLowerCase()})
})()`
}

/** Read current value after a fill (verification). */
export function buildReadValueScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var v=el.isContentEditable?String(el.textContent||''):String(el.value||'');
return JSON.stringify({ok:true,value:v.slice(0,200)})
})()`
}
