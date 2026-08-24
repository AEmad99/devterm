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

/**
 * Guest-side pointer overlay. Returns a Promise so executeJavaScript waits
 * for the glide; the operator sees the agent cursor move in real time.
 */
export const AGENT_CURSOR_RUNTIME = `function __dtMoveCursor(x,y,pulse){
  return new Promise(function(resolve){
    var id='__dt-agent-cursor';
    var cssId='__dt-agent-cursor-css';
    var el=document.getElementById(id);
    if(!el){
      if(!document.getElementById(cssId)){
        var st=document.createElement('style');
        st.id=cssId;
        st.textContent='#__dt-agent-cursor{position:fixed;left:0;top:0;width:32px;height:32px;pointer-events:none;z-index:2147483647;transform:translate3d(-48px,-48px,0);filter:drop-shadow(0 2px 4px rgba(20,12,40,.45));will-change:transform}#__dt-agent-cursor svg{display:block;width:32px;height:32px;transform-origin:6px 4px}#__dt-agent-cursor.__dt-click svg{animation:__dt-cursor-pop .22s cubic-bezier(.2,.9,.3,1)}@keyframes __dt-cursor-pop{0%{transform:scale(1)}35%{transform:scale(.78)}100%{transform:scale(1)}}';
        document.documentElement.appendChild(st);
      }
      el=document.createElement('div');
      el.id=id;
      el.setAttribute('aria-hidden','true');
      el.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#f7f5ff" stroke="#23183a" stroke-width="1.5" stroke-linejoin="round" d="M5 3.2 5.6 24.8l6.4-5.5 3.9 9.1 3.7-1.6-3.9-8.9L24.2 17z"/><path fill="#8b6cff" d="M7 6.2 7.4 21.6l4.7-4.1 3 6.9 1.8-.8-3-6.7 5.5-1.2z"/></svg>';
      document.documentElement.appendChild(el);
    }
    var prev=window.__dtAgentCursorPos||{x:-40,y:-40};
    el.style.transition='none';
    el.style.transform='translate3d('+prev.x+'px,'+prev.y+'px,0)';
    void el.offsetWidth;
    el.style.transition='transform 280ms cubic-bezier(.22,.85,.28,1)';
    el.style.transform='translate3d('+x+'px,'+y+'px,0)';
    window.__dtAgentCursorPos={x:x,y:y};
    setTimeout(function(){
      if(!pulse){resolve();return}
      el.classList.remove('__dt-click');
      void el.offsetWidth;
      el.classList.add('__dt-click');
      setTimeout(function(){el.classList.remove('__dt-click');resolve()},200);
    },290);
  });
}`

export function buildClickScript(ref: string): string {
  return `(function(){
${resolvePrelude(ref)}
${AGENT_CURSOR_RUNTIME}
var r=el.getBoundingClientRect();
var x=r.left+r.width/2,y=r.top+r.height/2;
return __dtMoveCursor(x,y,true).then(function(){
var opts={bubbles:true,cancelable:true,view:window,clientX:x,clientY:y};
try{el.focus({preventScroll:true})}catch(_e){}
if(typeof PointerEvent==='function'){el.dispatchEvent(new PointerEvent('pointerdown',opts));el.dispatchEvent(new PointerEvent('pointerup',opts))}
el.dispatchEvent(new MouseEvent('mousedown',opts));
el.dispatchEvent(new MouseEvent('mouseup',opts));
el.click();
return JSON.stringify({ok:true,detail:(el.tagName||'').toLowerCase()+(el.innerText?(' "'+String(el.innerText).slice(0,60)+'"'):'')})
})})()`
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
${AGENT_CURSOR_RUNTIME}
var r=el.getBoundingClientRect();
var x=r.left+Math.min(24,r.width/2),y=r.top+r.height/2;
return __dtMoveCursor(x,y,false).then(function(){
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
return JSON.stringify({ok:true,detail:'typed'})
})})()`
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
