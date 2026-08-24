/**
 * Page outline extraction for the MCP `browser_snapshot` tool.
 *
 * `buildSnapshotScript()` returns an IIFE string that runs inside the guest
 * page via `webContents.executeJavaScript`: it walks the DOM breadth-first,
 * tags interactive elements with stable `data-dt-ref` attributes, and returns
 * a JSON-serializable outline tree. `formatOutline()` turns that tree into
 * compact, model-friendly text. Both are pure/host-side-testable — the script
 * is just a string until executed, the formatter never touches a DOM.
 *
 * Refs survive in the page until the next snapshot overwrites them, so
 * `browser_click` / `browser_type` resolve `[data-dt-ref="eN"]` after a fresh
 * snapshot — the same contract Playwright-trained models expect.
 */

/** Node shape produced by the injected script (JSON-safe). */
export interface OutlineNode {
  r: string // role: heading|link|button|textbox|select|checkbox|radio|tab|img|text|group…
  n?: string // name (accessible-ish label, capped)
  href?: string
  ref?: string // data-dt-ref value — interactive elements only
  lvl?: number // heading level
  v?: string // current input value (capped)
  chk?: boolean // checked state
  kids?: OutlineNode[]
}

export interface SnapshotPayload {
  title: string
  url: string
  root: OutlineNode | null
}

export interface SnapshotOptions {
  /** Hard cap on visited nodes (default 400). */
  maxNodes?: number
}

const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,' +
  '[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],' +
  '[role=textbox],[role=combobox],[role=option],[contenteditable="true"],[onclick]'

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe'
])

/**
 * Build the full script body evaluated inside the guest. Kept ES5-ish and
 * dependency-free because it executes in whatever page the agent navigated
 * to (strict-mode pages included).
 */
export function buildSnapshotScript(opts: SnapshotOptions = {}): string {
  const maxNodes = Math.max(50, Math.min(1000, opts.maxNodes ?? 400))
  return `(function(){
var MAX=${maxNodes},SEQ=0;
var old=document.querySelectorAll('[data-dt-ref]');
for(var k=0;k<old.length;k++)old[k].removeAttribute('data-dt-ref');
function tag(el){el.setAttribute('data-dt-ref','e'+(++SEQ));return 'e'+SEQ}
function txt(el){var t=(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim();return t.slice(0,120)}
function name(el){return (
  el.getAttribute('aria-label')||
  (el.tagName==='INPUT'&&(el.placeholder||el.name))||
  el.getAttribute('alt')||el.getAttribute('title')||txt(el)||'').slice(0,120)}
function hidden(el){if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return true;
  var s=null;try{s=getComputedStyle(el)}catch(e){}
  return !!(s&&(s.display==='none'||s.visibility==='hidden'||s.opacity==='0'))}
function visit(el,depth,out){
  if(out.count>=MAX||depth>18)return;
  if(el.nodeType===3){var t=(el.nodeValue||'').replace(/\\s+/g,' ').trim();
    if(t)out.kids.push({r:'text',n:t.slice(0,160)});return}
  if(el.nodeType!==1)return;
  var tn=el.tagName.toLowerCase();
  if(tn==='svg')tn='svg';
  if(SKIP.has(tn)){if(tn==='iframe')out.kids.push({r:'iframe',n:name(el)});
    else if(tn==='canvas')out.kids.push({r:'img',n:'[canvas]'});return}
  if(hidden(el))return;
  var node={r:''};
  var m=/^h([1-6])$/.exec(tn);
  if(m){node.r='heading';node.lvl=+m[1];node.n=txt(el)}
  else if(tn==='a'&&el.getAttribute('href')){node.r='link';node.n=name(el);
    node.href=(el.getAttribute('href')||'').slice(0,300)}
  else if(tn==='button'){node.r='button';node.n=name(el)}
  else if(tn==='input'){var ty=(el.type||'text').toLowerCase();
    node.r=(ty==='checkbox'||ty==='radio')?ty:(ty==='submit'||ty==='button')?'button':'textbox';
    node.n=name(el);if(node.r==='textbox'){var v=String(el.value||'').slice(0,80);if(v)node.v=v}
    if(ty==='checkbox'||ty==='radio')node.chk=!!el.checked}
  else if(tn==='textarea'){node.r='textbox';node.n=name(el);
    var tv=String(el.value||'').slice(0,80);if(tv)node.v=tv}
  else if(tn==='select'){node.r='select';node.n=name(el)}
  else if(tn==='option'){node.r='option';node.n=txt(el)}
  else if(tn==='label'){node.r='label';node.n=txt(el)}
  else if(tn==='img'){node.r='img';node.n=name(el)}
  else{var ro=el.getAttribute('role');
    node.r=ro||(/^(nav|main|header|footer|form|table|ul|ol)$/.test(tn)?tn:'group')}
  if(INTERACTIVE_SEL && el.matches(INTERACTIVE_SEL))node.ref=tag(el);
  var entry={kids:[]};entry.node=node;
  out.kids.push(node);out.count++;
  var kids=[];
  for(var i=0;i<el.children.length;i++)kids.push(el.children[i]);
  var childOut={kids:[],count:out.count};
  for(var j=0;j<kids.length;j++)visit(kids[j],depth+1,childOut);
  out.count=childOut.count;
  if(childOut.kids.length)node.kids=childOut.kids;
}
function collapse(n){if(!n)return n;
  if(n.kids){n.kids=n.kids.map(collapse).filter(Boolean);
    if(!n.kids.length)delete n.kids}
  return n}
var SKIP=new Set(${JSON.stringify(Array.from(SKIP_TAGS))});
var INTERACTIVE_SEL=${JSON.stringify(INTERACTIVE)};
var out={kids:[],count:0};
visit(document.body,1,out);
return JSON.stringify({title:document.title,url:location.href,
  root:{r:'page',title:document.title,url:String(location.href),
  kids:collapse({r:'g',kids:out.kids}).kids}})})()`
}

/** Parse the script's stringified return into typed payload. */
export function parseSnapshot(raw: unknown): SnapshotPayload {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
  const p = obj as Partial<SnapshotPayload>
  if (!p || typeof p.url !== 'string') throw new Error('malformed snapshot payload')
  return {
    title: typeof p.title === 'string' ? p.title : '',
    url: p.url,
    root: p.root ?? null
  }
}

/**
 * Render the outline as compact indented text. `maxChars` hard-caps output
 * (default 20_000) so a huge page can't blow up the model context; the cut
 * is marked so the model knows to narrow its view.
 */
export function formatOutline(payload: SnapshotPayload, maxChars = 20000): string {
  const lines: string[] = [`PAGE ${payload.title || '(untitled)'} · ${payload.url}`]
  const walk = (node: OutlineNode, depth: number): void => {
    if (lines.join('\n').length > maxChars) return
    const pad = '  '.repeat(Math.max(0, depth))
    let s = `${pad}${node.r}`
    if (node.lvl) s += ` [h${node.lvl}]`
    if (node.n) s += ` "${node.n}"`
    if (node.v) s += ` value="${node.v}"`
    if (node.chk !== undefined) s += node.chk ? ' [checked]' : ' [unchecked]'
    if (node.href && node.href !== '#') s += ` → ${node.href}`
    if (node.ref) s += ` [${node.ref}]`
    lines.push(s)
    for (const k of node.kids ?? []) walk(k, depth + 1)
  }
  for (const k of payload.root?.kids ?? []) walk(k, 0)
  let out = lines.join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n…[outline truncated]'
  return out
}
