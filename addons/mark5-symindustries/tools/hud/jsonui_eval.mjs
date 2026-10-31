// Minimal evaluator for the JSON UI binding-expression subset used by the Mark V HUD, plus a
// resolver that walks our generated control tree for a given title string, and the HUD string
// encoder (mirror of the protocol in tools/hud_protocol.json) used to build sample titles.
//
// Supported grammar (STRICT: every binary operation must have its own parentheses, so operator
// precedence in the real engine can never change the meaning):
//   expr  := atom | '(' expr ')' | '(' 'not' expr ')' | '(' expr OP expr ')'
//   atom  := 'string literal' | number | #binding_name
//   OP    := * + - = > < and or
// Semantics (as documented on the Bedrock wiki, json-ui-intro "Using operators" / "String
// Formatting" and best-practices "(#x * 1)"):
//   ('%.Ns' * str)  first N BYTES (UTF-8) of str
//   str - str       remove occurrences of the right string ("all" by default; "first" selectable)
//   str + str       concatenation;  (x * 1) converts a numeric string to a number
//   =               equality (numeric when both sides are numbers)
//   and / or / not  booleans
import { readFileSync } from "node:fs";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: false });

export const utf8Len = (s) => enc.encode(s).length;

/** First n bytes of s. Returns { text, splitChar } (splitChar = a multi-byte char was cut). */
export function truncBytes(s, n) {
  const b = enc.encode(s);
  if (b.length <= n) return { text: s, splitChar: false };
  let end = n;
  let split = false;
  while (end > 0 && (b[end] & 0xc0) === 0x80) {
    end--;
    split = true;
  }
  return { text: dec.decode(b.slice(0, end)), splitChar: split };
}

// --------------------------------------------------------------------- tokenizer --
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ t: c });
      i++;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error(`unterminated string in ${src}`);
      out.push({ t: "str", v: src.slice(i + 1, j) });
      i = j + 1;
    } else if ("*+-=<>/".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else if (c === "#" || c === "$") {
      const m = /^[#$][A-Za-z0-9_]+/.exec(src.slice(i));
      if (!m) throw new Error(`bad name at ${i} in ${src}`);
      out.push({ t: "name", v: m[0] });
      i += m[0].length;
    } else if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else {
      const m = /^[A-Za-z_]+/.exec(src.slice(i));
      if (!m) throw new Error(`unexpected '${c}' at ${i} in ${src}`);
      const w = m[0];
      if (w === "and" || w === "or") out.push({ t: "op", v: w });
      else if (w === "not") out.push({ t: "not" });
      else throw new Error(`unknown word '${w}' in ${src}`);
      i += w.length;
    }
  }
  return out;
}

// ------------------------------------------------------------------------ parser --
export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => {
    const k = toks[p];
    if (!k || (t && k.t !== t)) throw new Error(`expected ${t} at token ${p} in ${src}`);
    p++;
    return k;
  };
  function expr() {
    const k = peek();
    if (!k) throw new Error(`unexpected end in ${src}`);
    if (k.t === "(") {
      take("(");
      if (peek() && peek().t === "not") {
        take("not");
        const a = expr();
        take(")");
        return { k: "not", a };
      }
      const a = expr();
      if (peek() && peek().t === ")") {
        take(")");
        return a;
      }
      const op = take("op").v;
      const b = expr();
      if (peek() && peek().t !== ")") throw new Error(`not fully parenthesized (more than one operator in a group) in ${src}`);
      take(")");
      return { k: "bin", op, a, b };
    }
    if (k.t === "str") return { k: "str", v: take().v };
    if (k.t === "num") return { k: "num", v: take().v };
    if (k.t === "name") return { k: "name", v: take().v };
    throw new Error(`unexpected token ${JSON.stringify(k)} in ${src}`);
  }
  const ast = expr();
  if (p !== toks.length) throw new Error(`trailing tokens in ${src}`);
  return ast;
}

const FMT = /^%\.(\d+)s$/;

export function evaluate(ast, scope, opts = {}) {
  const minus = opts.minus || "all";
  const trace = opts.trace;
  const ev = (n) => evaluate(n, scope, opts);
  switch (n_k(ast)) {
    case "str":
      return ast.v;
    case "num":
      return ast.v;
    case "name":
      if (!(ast.v in scope)) throw new Error(`unbound ${ast.v}`);
      return scope[ast.v];
    case "not":
      return !truthy(ev(ast.a));
    case "bin": {
      const a = ev(ast.a);
      const b = ev(ast.b);
      switch (ast.op) {
        case "*": {
          if (typeof a === "string" && FMT.test(a) && typeof b === "string") {
            const r = truncBytes(b, Number(FMT.exec(a)[1]));
            if (trace && r.splitChar) trace.push({ kind: "split", fmt: a });
            return r.text;
          }
          return toNum(a) * toNum(b);
        }
        case "+":
          if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
          return a + b;
        case "-":
          if (typeof a === "string" && typeof b === "string") {
            if (b === "") return a;
            if (minus === "first") {
              const i = a.indexOf(b);
              return i < 0 ? a : a.slice(0, i) + a.slice(i + b.length);
            }
            return a.split(b).join("");
          }
          return toNum(a) - toNum(b);
        case "=":
          if (typeof a === "number" && typeof b === "number") return a === b;
          return String(a) === String(b);
        case ">":
          return toNum(a) > toNum(b);
        case "<":
          return toNum(a) < toNum(b);
        case "and":
          return truthy(a) && truthy(b);
        case "or":
          return truthy(a) || truthy(b);
        default:
          throw new Error(`op ${ast.op}`);
      }
    }
    default:
      throw new Error(`node ${JSON.stringify(ast)}`);
  }
}
const n_k = (n) => n.k;
const truthy = (v) => (typeof v === "string" ? v !== "" && v !== "0" && v !== "false" : !!v);
const toNum = (v) => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const x = parseFloat(String(v).trim());
  return Number.isFinite(x) ? x : 0;
};

export const evalExpr = (src, scope, opts) => evaluate(parse(src), scope, opts);

// ------------------------------------------------------------- control resolver --
/**
 * Walk the control tree of our namespace for one title string.
 * Returns a flat list of nodes: { path, name, def, parentPath, own:{visible,text,texture},
 * visible (effective), bound:{text?,texture?,visible?} }.
 * Controls referencing another element ("a@ns.b") are not used inside our namespace (asserted).
 */
export function resolveTree(nsJson, rootName, title, opts = {}) {
  const out = [];
  const walk = (name, def, parentPath, parentVisible) => {
    if (name.includes("@")) throw new Error(`control inheritance not supported: ${name}`);
    const path = parentPath ? `${parentPath}/${name}` : name;
    const scope = {};
    const own = {
      visible: def.visible === undefined ? true : !!def.visible,
      text: def.text,
      texture: def.texture,
    };
    if (def.property_bag) {
      if ("#texture" in def.property_bag) own.texture = def.property_bag["#texture"];
    }
    const bound = {};
    for (const b of def.bindings || []) {
      if (b.binding_type === "view") {
        const v = evalExpr(b.source_property_name, scope, opts);
        const tgt = b.target_property_name;
        bound[tgt.slice(1)] = v;
        if (tgt === "#visible") own.visible = typeof v === "boolean" ? v : truthy(v);
        else if (tgt === "#text") own.text = v;
        else if (tgt === "#texture") own.texture = v;
        else throw new Error(`unexpected target ${tgt} on ${path}`);
      } else if (b.binding_name === "#hud_title_text_string") {
        scope["#hud_title_text_string"] = title;
      } else {
        throw new Error(`unexpected binding on ${path}: ${JSON.stringify(b)}`);
      }
    }
    const visible = parentVisible && own.visible;
    const node = { path, name, def, parentPath, own, visible, bound };
    out.push(node);
    for (const c of def.controls || []) {
      for (const [cn, cd] of Object.entries(c)) walk(cn, cd, path, visible);
    }
  };
  walk(rootName, nsJson[rootName], "", true);
  return out;
}

// ------------------------------------------------------------------ HUD encoder --
export function loadProtocol(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Pads/truncates a text field to exactly `width` bytes (ASCII space padding, char boundary). */
export function fitText(s, width) {
  const t = truncBytes(s, width).text;
  return t + " ".repeat(width - utf8Len(t));
}

/**
 * Build the HUD title string from field values (protocol order). char/digits fields must be
 * exactly their width in ASCII; text fields are padded/truncated to their byte width.
 * Returns { title, values } where values[name] is the exact field content that was encoded.
 */
export function encodeHud(proto, fields) {
  let s = proto.header;
  const values = {};
  for (const f of proto.fields) {
    let v = fields[f.name];
    if (v === undefined) v = defaultField(f);
    v = String(v);
    if (f.type === "text") {
      v = fitText(v, f.width);
    } else {
      if (f.type === "digits") v = v.padStart(f.width, "0");
      if (!/^[\x20-\x7e]*$/.test(v) || v.length !== f.width) throw new Error(`field ${f.name} must be ${f.width} ASCII chars, got '${v}'`);
    }
    values[f.name] = v;
    s += v;
  }
  if (utf8Len(s) !== proto.totalBytes) throw new Error(`encoded ${utf8Len(s)} bytes, expected ${proto.totalBytes}`);
  return { title: s, values };
}

export function defaultField(f) {
  if (f.type === "text") return "";
  if (f.type === "digits") return "0".repeat(f.width);
  const d = { mode: "1", energy_state: "n", reticle: "i", lock_frame: "0", target_class: "0", flight: "0", scan: "0", alert: "0", lock_mode: "0", threat: "0", integrity_state: "n" };
  return d[f.name] ?? "0";
}

/** The exact "HUD off" string from SPEC 3.1: "MK5H0" padded with spaces to full length. */
export function offString(proto) {
  return (proto.header + "0").padEnd(proto.totalBytes, " ");
}
