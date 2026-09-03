/**
 * Minimal OData v2/v3 query support as used by Vista Connect V1:
 *   $filter (eq, ne, gt, ge, lt, le, and, or, not, parentheses, string/number/bool/datetime literals,
 *            substringof('x', Field), startswith(Field,'x'), tolower(Field))
 *   $select, $expand, $top, $skip, $orderby, $format
 * Works on plain JSON objects (already serialised Vista entities).
 */

type Tok = { t: "id" | "str" | "num" | "op" | "lp" | "rp" | "comma" | "bool" | "dt" | "null"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      out.push({ t: "lp", v: c });
      i++;
      continue;
    }
    if (c === ")") {
      out.push({ t: "rp", v: c });
      i++;
      continue;
    }
    if (c === ",") {
      out.push({ t: "comma", v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'") break;
        s += src[j];
        j++;
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const dt = src.slice(i).match(/^datetime'([^']*)'/i);
    if (dt) {
      out.push({ t: "dt", v: dt[1]! });
      i += dt[0].length;
      continue;
    }
    // DATETIME '2021-11-01T00:00:00' (VOX doc has a space)
    const dt2 = src.slice(i).match(/^datetime\s+'([^']*)'/i);
    if (dt2) {
      out.push({ t: "dt", v: dt2[1]! });
      i += dt2[0].length;
      continue;
    }
    const num = src.slice(i).match(/^-?\d+(\.\d+)?[LMDF]?/i);
    if (num && !/^[A-Za-z_]/.test(c)) {
      out.push({ t: "num", v: num[0].replace(/[LMDF]$/i, "") });
      i += num[0].length;
      continue;
    }
    const id = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_./]*/);
    if (id) {
      const w = id[0];
      const lw = w.toLowerCase();
      if (["eq", "ne", "gt", "ge", "lt", "le", "and", "or", "not"].includes(lw)) out.push({ t: "op", v: lw });
      else if (lw === "true" || lw === "false") out.push({ t: "bool", v: lw });
      else if (lw === "null") out.push({ t: "null", v: "null" });
      else out.push({ t: "id", v: w });
      i += w.length;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in $filter at ${i}`);
  }
  return out;
}

type Node =
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "not"; e: Node }
  | { k: "cmp"; op: string; l: Node; r: Node }
  | { k: "field"; name: string }
  | { k: "lit"; v: unknown }
  | { k: "fn"; name: string; args: Node[] };

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek() {
    return this.toks[this.i];
  }
  next() {
    return this.toks[this.i++];
  }
  expect(t: Tok["t"]) {
    const x = this.next();
    if (!x || x.t !== t) throw new Error(`Expected ${t} in $filter`);
    return x;
  }
  parseOr(): Node {
    let l = this.parseAnd();
    while (this.peek()?.t === "op" && this.peek()!.v === "or") {
      this.next();
      l = { k: "bin", op: "or", l, r: this.parseAnd() };
    }
    return l;
  }
  parseAnd(): Node {
    let l = this.parseNot();
    while (this.peek()?.t === "op" && this.peek()!.v === "and") {
      this.next();
      l = { k: "bin", op: "and", l, r: this.parseNot() };
    }
    return l;
  }
  parseNot(): Node {
    if (this.peek()?.t === "op" && this.peek()!.v === "not") {
      this.next();
      return { k: "not", e: this.parseNot() };
    }
    return this.parseCmp();
  }
  parseCmp(): Node {
    const l = this.parsePrimary();
    const p = this.peek();
    if (p?.t === "op" && ["eq", "ne", "gt", "ge", "lt", "le"].includes(p.v)) {
      this.next();
      return { k: "cmp", op: p.v, l, r: this.parsePrimary() };
    }
    return l;
  }
  parsePrimary(): Node {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of $filter");
    if (t.t === "lp") {
      const e = this.parseOr();
      this.expect("rp");
      return e;
    }
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "bool") return { k: "lit", v: t.v === "true" };
    if (t.t === "null") return { k: "lit", v: null };
    if (t.t === "dt") return { k: "lit", v: new Date(t.v.endsWith("Z") ? t.v : `${t.v}Z`).getTime() };
    if (t.t === "id") {
      if (this.peek()?.t === "lp") {
        this.next();
        const args: Node[] = [];
        if (this.peek()?.t !== "rp") {
          args.push(this.parseOr());
          while (this.peek()?.t === "comma") {
            this.next();
            args.push(this.parseOr());
          }
        }
        this.expect("rp");
        return { k: "fn", name: t.v.toLowerCase(), args };
      }
      return { k: "field", name: t.v };
    }
    throw new Error(`Unexpected token ${t.v} in $filter`);
  }
}

function getField(obj: Record<string, unknown>, name: string): unknown {
  const parts = name.split(/[./]/);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object") {
      const o = cur as Record<string, unknown>;
      const key = Object.keys(o).find((k) => k.toLowerCase() === p.toLowerCase());
      cur = key ? o[key] : undefined;
    } else return undefined;
  }
  return cur;
}

function norm(v: unknown): unknown {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return new Date(v.endsWith("Z") ? v : `${v}Z`).getTime();
  return v;
}

function evalNode(n: Node, row: Record<string, unknown>): unknown {
  switch (n.k) {
    case "lit":
      return n.v;
    case "field":
      return getField(row, n.name);
    case "not":
      return !evalNode(n.e, row);
    case "bin": {
      const l = evalNode(n.l, row);
      return n.op === "and" ? Boolean(l) && Boolean(evalNode(n.r, row)) : Boolean(l) || Boolean(evalNode(n.r, row));
    }
    case "cmp": {
      let l = norm(evalNode(n.l, row));
      let r = norm(evalNode(n.r, row));
      if (typeof l === "string" && typeof r === "string") {
        l = l.toLowerCase();
        r = r.toLowerCase();
      }
      switch (n.op) {
        case "eq":
          return l === r || (l == null && r == null);
        case "ne":
          return l !== r;
        case "gt":
          return (l as number) > (r as number);
        case "ge":
          return (l as number) >= (r as number);
        case "lt":
          return (l as number) < (r as number);
        case "le":
          return (l as number) <= (r as number);
      }
      return false;
    }
    case "fn": {
      const a = n.args.map((x) => evalNode(x, row));
      const s = (v: unknown) => String(v ?? "").toLowerCase();
      switch (n.name) {
        case "substringof":
          return s(a[1]).includes(s(a[0]));
        case "startswith":
          return s(a[0]).startsWith(s(a[1]));
        case "endswith":
          return s(a[0]).endsWith(s(a[1]));
        case "tolower":
          return s(a[0]);
        case "toupper":
          return String(a[0] ?? "").toUpperCase();
        case "contains":
          return s(a[0]).includes(s(a[1]));
        default:
          throw new Error(`Unsupported function ${n.name}`);
      }
    }
  }
}

export function compileFilter(filter: string | undefined): (row: Record<string, unknown>) => boolean {
  if (!filter || !filter.trim()) return () => true;
  const ast = new Parser(tokenize(filter)).parseOr();
  return (row) => Boolean(evalNode(ast, row));
}

export type ODataQuery = { filter?: string; select?: string; expand?: string; top?: string; skip?: string; orderby?: string; format?: string };

export function applyQuery<T extends Record<string, unknown>>(rows: T[], q: ODataQuery, opts: { expandable?: string[] } = {}): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = rows.filter(compileFilter(q.filter));
  if (q.orderby) {
    const [field, dir] = q.orderby.trim().split(/\s+/);
    const mul = (dir ?? "asc").toLowerCase() === "desc" ? -1 : 1;
    out = [...out].sort((a, b) => {
      const av = norm(getField(a, field!)) as number | string;
      const bv = norm(getField(b, field!)) as number | string;
      return av < bv ? -mul : av > bv ? mul : 0;
    });
  }
  if (q.skip) out = out.slice(Number(q.skip));
  if (q.top) out = out.slice(0, Number(q.top));
  // $expand: navigation properties are inlined by default in this mock; without $expand we strip the heavy ones
  const expandable = opts.expandable ?? [];
  const expanded = new Set((q.expand ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  if (expandable.length) {
    out = out.map((r) => {
      const copy = { ...r };
      for (const e of expandable) if (!expanded.has(e)) delete copy[e];
      return copy;
    });
  }
  if (q.select) {
    const fields = q.select.split(",").map((x) => x.trim()).filter(Boolean);
    out = out.map((r) => Object.fromEntries(fields.map((f) => [Object.keys(r).find((k) => k.toLowerCase() === f.toLowerCase()) ?? f, getField(r, f)])));
  }
  return out;
}

/** Hono's query parser gives us `$filter` etc. as keys; normalise to ODataQuery. */
export function readQuery(q: Record<string, string | undefined>): ODataQuery {
  const g = (k: string) => q[`$${k}`] ?? q[k];
  return { filter: g("filter"), select: g("select"), expand: g("expand"), top: g("top"), skip: g("skip"), orderby: g("orderby"), format: g("format") };
}
