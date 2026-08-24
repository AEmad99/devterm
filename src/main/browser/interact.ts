/**
 * DOM-level interaction scripts for the MCP browser tools.
 *
 * Each builder returns an IIFE string for `webContents.executeJavaScript`
 * (same contract as buildSnapshotScript: string in, JSON-string out).
 * Interactions dispatch real DOM events — not CDP synthesized input — which
 * works with React/Vue state-bound forms because values go through the
 * native setters before `input`/`change` fire. Known limitation (documented
 * in tool descriptions): events are `isTrusted:false`, so hardened pages may
 * ignore them; the CDP Input path is the phase-2 upgrade.
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

function resolvePrelude(ref: string): string {
  const missing = JSON.stringify({
    err: `ref ${ref} no longer exists — the page changed since your last snapshot; run browser_snapshot again`
  })
  return `var el=document.querySelector('[data-dt-ref=${JSON.stringify(ref)}]');
if(!el)return ${missing};
try{el.scrollIntoView({block:'center',behavior:'instant'})}catch(_e){}`
}

export function buildClickScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
var r=el.getBoundingClientRect();
var opts={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
try{el.focus({preventScroll:true})}catch(_e){}
if(typeof PointerEvent==='function'){el.dispatchEvent(new PointerEvent('pointerdown',opts));el.dispatchEvent(new PointerEvent('pointerup',opts))}
el.dispatchEvent(new MouseEvent('mousedown',opts));
el.dispatchEvent(new MouseEvent('mouseup',opts));
el.click();
return JSON.stringify({ok:true,detail:(el.tagName||'').toLowerCase()+(el.innerText?(' "'+String(el.innerText).slice(0,60)+'"'):'')})})()`
}

export function buildTypeScript(ref: string, text: string, submit: boolean, allowPassword = false): string {
  return `(function(){
${resolvePrelude(ref)}
var isPwd=(el.tagName==='INPUT'&&String(el.type).toLowerCase()==='password');
if(isPwd&&!${allowPassword})return JSON.stringify({passwordField:true});
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
${submit
      ? `var form=el.closest('form');
if(form&&typeof form.requestSubmit==='function'){form.requestSubmit();return JSON.stringify({ok:true,detail:'typed + submitted form'})}
['keydown','keypress','keyup'].forEach(function(ty){el.dispatchEvent(new KeyboardEvent(ty,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))});`
      : ''}
return JSON.stringify({ok:true,detail:'typed'})})()`
}

export function buildKeyPressScript(key: string): string {
  const k = JSON.stringify(String(key).slice(0, 24))
  return `(function(){
var target=document.activeElement||document.body;
if(!target)target=document.body;
['keydown','keypress','keyup'].forEach(function(ty){
try{target.dispatchEvent(new KeyboardEvent(ty,{key:${k},code:${k},bubbles:true,cancelable:true}))}catch(_e){}});
return JSON.stringify({ok:true,detail:'sent '+${k}})})()`
}

