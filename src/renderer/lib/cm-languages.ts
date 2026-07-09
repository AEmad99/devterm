import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { sass } from '@codemirror/lang-sass'
import { vue } from '@codemirror/lang-vue'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { go } from '@codemirror/legacy-modes/mode/go'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { csharp } from '@codemirror/legacy-modes/mode/clike'
import { kotlin } from '@codemirror/legacy-modes/mode/clike'
import { objectiveC } from '@codemirror/legacy-modes/mode/clike'
import { scala } from '@codemirror/legacy-modes/mode/clike'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { coffeeScript } from '@codemirror/legacy-modes/mode/coffeescript'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { oCaml } from '@codemirror/legacy-modes/mode/mllike'
import { fSharp } from '@codemirror/legacy-modes/mode/mllike'
import { commonLisp } from '@codemirror/legacy-modes/mode/commonlisp'
import { scheme } from '@codemirror/legacy-modes/mode/scheme'
import { tcl } from '@codemirror/legacy-modes/mode/tcl'
import { verilog } from '@codemirror/legacy-modes/mode/verilog'
import { vhdl } from '@codemirror/legacy-modes/mode/vhdl'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { puppet } from '@codemirror/legacy-modes/mode/puppet'
import { sieve } from '@codemirror/legacy-modes/mode/sieve'
import { solr } from '@codemirror/legacy-modes/mode/solr'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { troff } from '@codemirror/legacy-modes/mode/troff'
import { turtle } from '@codemirror/legacy-modes/mode/turtle'
import { vb } from '@codemirror/legacy-modes/mode/vb'
import { vbScript } from '@codemirror/legacy-modes/mode/vbscript'
import { velocity } from '@codemirror/legacy-modes/mode/velocity'
import { webIDL } from '@codemirror/legacy-modes/mode/webidl'
import { xQuery } from '@codemirror/legacy-modes/mode/xquery'

/** Wrap a legacy stream parser into a CodeMirror 6 extension. */
function legacy(mode: Parameters<typeof StreamLanguage.define>[0]): Extension {
  return StreamLanguage.define(mode).extension
}

/** Extension lookup for files without a useful extension (e.g. Dockerfile, Makefile). */
const FILENAME_LANGS: Record<string, Extension> = {
  dockerfile: legacy(dockerFile),
  makefile: legacy(shell),
  gnumakefile: legacy(shell),
  'cmakelists.txt': legacy(cmake),
  vagrantfile: legacy(ruby),
  gemfile: legacy(ruby),
  rakefile: legacy(ruby),
  brewfile: legacy(ruby),
  podfile: legacy(ruby),
  'package.json': json(),
  'tsconfig.json': json(),
  'jsconfig.json': json(),
  '.bashrc': legacy(shell),
  '.zshrc': legacy(shell),
  '.profile': legacy(shell),
  '.bash_profile': legacy(shell),
  '.bash_logout': legacy(shell),
  '.vimrc': legacy(shell),
  '.gitconfig': legacy(properties),
  '.gitignore': legacy(shell),
  '.gitattributes': legacy(shell),
  '.dockerignore': legacy(shell),
  '.editorconfig': legacy(properties),
  '.npmrc': legacy(properties),
  '.yarnrc': legacy(properties),
  '.env': legacy(properties),
  '.env.example': legacy(properties),
  '.env.local': legacy(properties),
  '.env.production': legacy(properties),
  '.env.development': legacy(properties),
  'nginx.conf': legacy(nginx),
  'php.ini': php(),
  'pyproject.toml': legacy(toml),
  'cargo.toml': legacy(toml),
  'poetry.lock': legacy(toml),
  'composer.lock': json(),
  'yarn.lock': yaml(),
  'pnpm-lock.yaml': yaml(),
  'gemfile.lock': legacy(ruby)
}

/** Extension lookup by lower-cased file extension. */
const EXT_LANGS: Record<string, Extension> = {
  // JavaScript / TypeScript
  js: javascript(),
  jsx: javascript({ jsx: true }),
  mjs: javascript(),
  cjs: javascript(),
  ts: javascript({ typescript: true }),
  tsx: javascript({ typescript: true, jsx: true }),

  // Web
  html: html(),
  htm: html(),
  css: css(),
  less: css(),
  scss: sass(),
  sass: sass(),
  vue: vue(),
  svelte: javascript(), // Svelte files are close enough to JS/TS markup

  // Data / config
  json: json(),
  jsonc: json(),
  json5: json(),
  yaml: yaml(),
  yml: yaml(),
  toml: legacy(toml),
  ini: legacy(properties),
  cfg: legacy(properties),
  env: legacy(properties),
  conf: legacy(properties),

  // Documentation
  md: markdown(),
  markdown: markdown(),
  mdown: markdown(),
  mkd: markdown(),

  // Python
  py: python(),
  pyw: python(),
  pyi: python(),

  // Rust
  rs: rust(),

  // C / C++ / family
  c: cpp(),
  cpp: cpp(),
  cc: cpp(),
  cxx: cpp(),
  h: cpp(),
  hpp: cpp(),
  hh: cpp(),
  hxx: cpp(),
  inc: cpp(),
  ipp: cpp(),
  'c++': cpp(),

  // Java / JVM
  java: java(),
  jsp: java(),
  kt: legacy(kotlin),
  kts: legacy(kotlin),
  scala: legacy(scala),
  sc: legacy(scala),
  groovy: legacy(groovy),
  gradle: legacy(groovy),
  clj: legacy(clojure),
  cljs: legacy(clojure),
  edn: legacy(clojure),

  // .NET
  cs: legacy(csharp),
  csx: legacy(csharp),
  fs: legacy(fSharp),
  fsx: legacy(fSharp),
  fsi: legacy(fSharp),
  vb: legacy(vb),
  vbs: legacy(vbScript),

  // Apple
  swift: legacy(swift),
  m: legacy(objectiveC),
  mm: cpp(),

  // Shell / scripting
  sh: legacy(shell),
  bash: legacy(shell),
  zsh: legacy(shell),
  fish: legacy(shell),
  ksh: legacy(shell),
  csh: legacy(shell),
  tcsh: legacy(shell),
  ps1: legacy(powerShell),
  psm1: legacy(powerShell),
  psd1: legacy(powerShell),
  pssc: legacy(powerShell),

  // PHP
  php: php(),
  phtml: php(),

  // Go
  go: legacy(go),

  // Ruby
  rb: legacy(ruby),
  rbw: legacy(ruby),
  rake: legacy(ruby),
  gemspec: legacy(ruby),

  // Perl
  pl: legacy(perl),
  pm: legacy(perl),

  // Lua
  lua: legacy(lua),

  // SQL
  sql: sql(),
  sqlite: sql(),
  mysql: sql(),
  pgsql: sql(),
  plsql: sql(),

  // XML / markup
  xml: xml(),
  svg: xml(),
  xsd: xml(),
  wsdl: xml(),
  xsl: xml(),
  xslt: xml(),

  // Functional
  erl: legacy(erlang),
  hrl: legacy(erlang),
  hs: legacy(haskell),
  lhs: legacy(haskell),
  ml: legacy(oCaml),
  mli: legacy(oCaml),
  lisp: legacy(commonLisp),
  cl: legacy(commonLisp),
  el: legacy(commonLisp),
  scm: legacy(scheme),
  ss: legacy(scheme),

  // Other systems
  coffee: legacy(coffeeScript),
  tf: legacy(properties), // Terraform/HCL approximate
  hcl: legacy(properties),
  dockerfile: legacy(dockerFile),
  nginx: legacy(nginx),
  proto: legacy(protobuf),
  puppet: legacy(puppet),
  pp: legacy(puppet),
  sieve: legacy(sieve),
  solr: legacy(solr),
  stex: legacy(stex),
  tex: legacy(stex),
  sty: legacy(stex),
  troff: legacy(troff),
  man: legacy(troff),
  ttl: legacy(turtle),
  vm: legacy(velocity),
  webidl: legacy(webIDL),
  xq: legacy(xQuery),
  xqy: legacy(xQuery),
  tcl: legacy(tcl),
  v: legacy(verilog),
  sv: legacy(verilog),
  vhd: legacy(vhdl),
  vhdl: legacy(vhdl),

  // Diff / patch
  diff: legacy(diff),
  patch: legacy(diff)
}

/** Pick a CodeMirror language extension from a filename, or none for plain text. */
export function languageFor(name: string): Extension[] {
  const base = name.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  const byName = FILENAME_LANGS[base]
  if (byName) return [byName]

  const ext = base.includes('.') ? (base.split('.').pop()?.toLowerCase() ?? '') : ''
  const byExt = ext ? EXT_LANGS[ext] : undefined
  return byExt ? [byExt] : []
}
