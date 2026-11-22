// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its break, its lines, and whether it ends with a break. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

const leadOf = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const trailTrim = (s: string): string => s.replace(/[ \t]+$/, '');
const bothTrim = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Positions where O occurs in F at one tier, at or after `from` (SPEC.md section 5). */
function occAt(O: string[], F: string[], tier: number, from: number): number[] {
  const norm = tier === 0 ? (s: string): string => s : tier === 1 ? trailTrim : bothTrim;
  const o = O.map(norm);
  const out: number[] = [];
  if (o.length === 0 || o.length > F.length - from) return out;
  for (let i = from; i + o.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(F[i + j]!) !== o[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs in F (at or after `from`), with its positions. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occAt(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line takes the file's own matched line O[ctx]; a fresh line is `text`. */
interface NLine {
  text: string;
  ctx: number;
}
interface Block {
  o: string[];
  n: NLine[];
}

/** The lines N writes when O matched at position i of doc at tier (section 5). */
function blockLines(b: Block, doc: Doc, i: number, tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && b.o.length > 0) {
    p = leadOf(b.o[0]!);
    f = leadOf(doc.lines[i]!);
  }
  for (const nl of b.n) {
    if (nl.ctx >= 0) {
      out.push(doc.lines[i + nl.ctx]!);
      continue;
    }
    let s = nl.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

/** Replace doc.lines[i, i+k) with rep, keeping the break, setting the final break to `fin`. */
function spliceDoc(doc: Doc, i: number, k: number, rep: string[], fin: boolean): Doc {
  return { lines: [...doc.lines.slice(0, i), ...rep, ...doc.lines.slice(i + k)], br: doc.br, final: fin };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified section (SPEC.md section 6). */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  /** A `\` line follows the section's last `+` line (creation files). */
  lastPlusNoNl: boolean;
}

/** Apply a section's hunks, in order, to a document; throws Fail on the first failure. */
function applyHunks(doc0: Doc, hunks: Hunk[], path: string, strict: boolean): Doc {
  let doc = doc0;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.min(h.a + d, doc.lines.length);
      const rep = blockLines(h, doc, pos, 0);
      const fin = pos === doc.lines.length ? !h.noNl : doc.final;
      doc = spliceDoc(doc, pos, 0, rep, fin);
      d += rep.length;
      continue;
    }
    const found = findTier(h.o, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const rep = blockLines(h, doc, pos, found.tier);
    const fin = pos + h.o.length === doc.lines.length ? !h.noNl : doc.final;
    doc = spliceDoc(doc, pos, h.o.length, rep, fin);
    d += rep.length - h.o.length;
  }
  return doc;
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  if (sec.create || sec.oldPath === null) {
    const p = sec.newPath;
    return (tree) => {
      if (p === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const nl of h.n) if (nl.ctx < 0) plus.push(nl.text);
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (sec.lastPlusNoNl ? '' : '\n'));
    };
  }
  if (sec.del || sec.newPath === null) {
    const p = sec.oldPath!;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (sec.oldPath !== sec.newPath) {
    const oldP = sec.oldPath!;
    const newP = sec.newPath!;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyHunks(parseDoc(text), sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      tree.moves.set(newP, oldP);
    };
  }
  const p = sec.oldPath!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const doc = applyHunks(parseDoc(text), sec.hunks, p, strict);
    tree.now.set(p, writeDoc(doc));
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

/** Read a patch as unified diffs (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = parseSection(lines, i + 1, m[1]!, m[2]!, edits, strict);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseSection(lines, i, null, null, edits, strict);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

/** The path a `--- `/`+++ ` line names: after the four characters, up to the first tab, spaces removed. */
function dashPath(l: string): string | null {
  const t = l.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

/**
 * Parse one section starting at `i` (after its `diff --git` line, or at its `--- ` line).
 * Returns the index just past the section.
 */
function parseSection(
  lines: string[],
  i: number,
  diffOld: string | null,
  diffNew: string | null,
  edits: Edit[],
  strict: boolean,
): number {
  const n = lines.length;
  let oldPath: string | null = diffOld;
  let newPath: string | null = diffNew;
  let create = false;
  let del = false;
  let sawPair = false;
  const hunks: Hunk[] = [];
  let lastPlusNoNl = false;
  // A section that starts on its `--- ` line opens with the pair.
  if (diffOld === null) {
    oldPath = dashPath(lines[i]!);
    newPath = dashPath(lines[i + 1]!);
    sawPair = true;
    i += 2;
  }
  // Header: until the first hunk, the next section, or the end.
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sawPair) break; // a later pair starts a new section
        oldPath = dashPath(l);
        newPath = dashPath(lines[i + 1]!);
        sawPair = true;
        i += 2;
        continue;
      }
      // A `--- ` line not followed by a `+++ ` line, in a header, is a parse error at the line after it.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!sawPair) oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!sawPair) newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) create = true;
    else if (l.startsWith('deleted file mode')) del = true;
    i += 1;
  }
  // The `--- `/`+++ ` pair belongs to this header when the section did not start on one.
  // (Handled below: a section that starts on `--- ` consumes the pair first.)
  // Hunks. Prose outside bodies is ignored, so a section's hunks need not be contiguous.
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (!l.startsWith('@@')) {
      i += 1;
      continue;
    }
    const hm = HUNK_HEAD.exec(l);
    if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
    const a = Number(hm[1]);
    i += 1;
    const body: string[] = [];
    while (i < n) {
      const bl = lines[i]!;
      if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
        body.push(bl);
        i += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    const o: string[] = [];
    const nn: NLine[] = [];
    let lastCtxPlus = -1;
    for (let j = 0; j < body.length; j += 1) {
      const bl = body[j]!;
      if (bl === '') {
        // An empty line is a context line whose text is empty.
        o.push('');
        nn.push({ text: '', ctx: o.length - 1 });
        lastCtxPlus = j;
      } else if (bl.startsWith(' ')) {
        o.push(bl.slice(1));
        nn.push({ text: bl.slice(1), ctx: o.length - 1 });
        lastCtxPlus = j;
      } else if (bl.startsWith('-')) {
        o.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        nn.push({ text: bl.slice(1), ctx: -1 });
        lastCtxPlus = j;
        if (j + 1 < body.length && body[j + 1]!.startsWith('\\')) lastPlusNoNl = true;
        else lastPlusNoNl = false;
      }
    }
    const noNl = lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]!.startsWith('\\');
    hunks.push({ a, o, n: nn, noNl });
  }
  edits.push(unifiedEdit({ oldPath, newPath, create, del, hunks, lastPlusNoNl }, strict));
  return i;
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseDoc(text);
    const found = findTier(oldLines, doc.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const i = found.pos[0]!;
    const rep = blockLines({ o: oldLines, n: newLines.map((t) => ({ text: t, ctx: -1 })) }, doc, i, found.tier);
    tree.now.set(path, writeDoc(spliceDoc(doc, i, oldLines.length, rep, doc.final)));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < n; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < n; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an optional anchor, its old/new lines, and whether it is end-of-file anchored. */
interface VChunk {
  anchor: string | null;
  block: Block;
  eof: boolean;
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseDoc(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier([chunk.anchor], doc.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (chunk.block.o.length === 0) {
        const pos = chunk.eof ? doc.lines.length : cursor;
        const rep = blockLines(chunk.block, doc, pos, 0);
        doc = spliceDoc(doc, pos, 0, rep, doc.final);
        cursor = pos + rep.length;
        continue;
      }
      const found = findTier(chunk.block.o, doc.lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos = found.pos[0]!;
      if (chunk.eof) {
        const atEnd = found.pos.find((p) => p + chunk.block.o.length === doc.lines.length);
        if (atEnd === undefined) throw new Fail('no-match', path);
        pos = atEnd;
      }
      const rep = blockLines(chunk.block, doc, pos, found.tier);
      doc = spliceDoc(doc, pos, chunk.block.o.length, rep, doc.final);
      cursor = pos + rep.length;
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.set(moveTo, path);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a patch as V4A (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSectionStart = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = isSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    // The section's body runs to the next section start or `*** End Patch`.
    let j = i + 1;
    while (j < last && isSectionStart(lines[j]!) === null) j += 1;
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    const base = i + 1; // global line index of body[0]
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let m = 0; m < body.length; m += 1) {
        const bl = body[m]!;
        if (bl === '') addLines.push('');
        else if (bl.startsWith('+')) addLines.push(bl.slice(1));
        else throw new Exit2(`error: parse ${base + m + 1}`);
      }
      edits.push(((p: string, ls: string[]): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
      })(path, addLines));
    } else if (kind === 'delete') {
      for (let m = 0; m < body.length; m += 1) {
        if (!blank(body[m]!)) throw new Exit2(`error: parse ${base + m + 1}`);
      }
      edits.push(((p: string): Edit => (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      })(path));
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      for (let m = k; m < body.length; m += 1) {
        const bl = body[m]!;
        const lineNo = base + m + 1;
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, block: { o: [], n: [] }, eof: false };
          chunks.push(cur);
          seenChunk = true;
        } else if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
          cur.eof = true;
          cur = null;
        } else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) {
            if (seenChunk) throw new Exit2(`error: parse ${lineNo}`);
            cur = { anchor: null, block: { o: [], n: [] }, eof: false };
            chunks.push(cur);
            seenChunk = true;
          }
          if (bl === '') {
            cur.block.o.push('');
            cur.block.n.push({ text: '', ctx: cur.block.o.length - 1 });
          } else if (bl.startsWith(' ')) {
            cur.block.o.push(bl.slice(1));
            cur.block.n.push({ text: bl.slice(1), ctx: cur.block.o.length - 1 });
          } else if (bl.startsWith('-')) {
            cur.block.o.push(bl.slice(1));
          } else {
            cur.block.n.push({ text: bl.slice(1), ctx: -1 });
          }
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a move that succeeded prints `R <old> -> <new>` (sorted by <new>) in place of its D and A.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const movedOld = new Set<string>();
  for (const [np, op] of tree.moves) {
    if (tree.original(op) !== null && tree.now.get(op) === null && tree.original(np) === null && tree.now.get(np) !== null) {
      rows.push({ key: np, line: `R ${op} -> ${np}` });
      movedOld.add(op);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p)) continue;
    if (tree.moves.has(p) && movedOld.has(tree.moves.get(p)!)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
