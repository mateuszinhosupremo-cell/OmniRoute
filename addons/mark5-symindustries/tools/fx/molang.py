"""Tiny Molang subset parser/evaluator used by the FX tests and previews.

Supports: numbers, variable/v/query/q/math identifiers (dotted, case-insensitive),
+ - * / unary - !, comparisons, == !=, && ||, ternary ?:, null-coalescing ??,
`expr ?? { stmt; stmt; }` blocks, assignment statements and `;` sequences.
Math: random, random_integer, clamp, lerp, pow, sqrt, sin/cos (degrees), floor,
abs, min, max, mod.  Unknown functions or syntax raise MolangError.
"""
import math
import random
import re

TOKEN = re.compile(r"\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)"
                   r"|(\?\?|&&|\|\||==|!=|<=|>=|[-+*/()<>!?:;,{}=]))")

ALIASES = {"v": "variable", "q": "query", "t": "temp", "c": "context"}


class MolangError(Exception):
    pass


class Missing:
    """Value of an unset variable (only legal as the left side of ??)."""


MISSING = Missing()


def tokenize(src):
    pos, out = 0, []
    src = src.strip()
    while pos < len(src):
        m = TOKEN.match(src, pos)
        if not m or m.end() == pos:
            raise MolangError(f"bad token at {pos}: {src[pos:pos + 20]!r}")
        num, ident, op = m.groups()
        if num is not None:
            out.append(("num", float(num)))
        elif ident is not None:
            parts = ident.lower().split(".")
            parts[0] = ALIASES.get(parts[0], parts[0])
            out.append(("id", ".".join(parts)))
        else:
            out.append(("op", op))
        pos = m.end()
        while pos < len(src) and src[pos].isspace():
            pos += 1
    out.append(("eof", None))
    return out


BIN = {"??": 1, "||": 3, "&&": 4, "==": 5, "!=": 5, "<": 6, ">": 6, "<=": 6, ">=": 6,
       "+": 7, "-": 7, "*": 8, "/": 8}
MATH = {"random", "random_integer", "clamp", "lerp", "pow", "sqrt", "sin", "cos", "floor", "abs",
        "min", "max", "mod"}


class Parser:
    def __init__(self, src):
        self.t = tokenize(src)
        self.i = 0

    def peek(self):
        return self.t[self.i]

    def take(self, kind=None, val=None):
        tok = self.t[self.i]
        if kind and tok[0] != kind or val is not None and tok[1] != val:
            raise MolangError(f"expected {val or kind}, got {tok}")
        self.i += 1
        return tok

    def program(self, end="eof"):
        stmts = []
        while True:
            tok = self.peek()
            if tok[0] == end or (end == "}" and tok == ("op", "}")):
                break
            stmts.append(self.statement())
            if self.peek() == ("op", ";"):
                self.take()
            elif not (self.peek()[0] == "eof" or self.peek() == ("op", "}")):
                raise MolangError(f"expected ; got {self.peek()}")
        return ("seq", stmts)

    def statement(self):
        tok = self.peek()
        nxt = self.t[self.i + 1]
        if tok[0] == "id" and nxt == ("op", "="):
            if not (tok[1].startswith("variable.") or tok[1].startswith("temp.")):
                raise MolangError(f"cannot assign to {tok[1]}")
            self.i += 2
            return ("set", tok[1], self.expr(0))
        return self.expr(0)

    def expr(self, minp):
        left = self.unary()
        while True:
            tok = self.peek()
            if tok[0] == "op" and tok[1] == "?" and minp <= 2:
                self.take()
                a = self.expr(2)
                self.take("op", ":")
                b = self.expr(2)
                left = ("tern", left, a, b)
                continue
            if tok[0] == "op" and tok[1] in BIN and BIN[tok[1]] >= minp and BIN[tok[1]] > 0:
                p = BIN[tok[1]]
                if p < minp:
                    break
                self.take()
                if tok[1] == "??" and self.peek() == ("op", "{"):
                    self.take()
                    blk = self.program(end="}")
                    self.take("op", "}")
                    right = ("block", blk)
                else:
                    right = self.expr(p + 1)
                left = ("bin", tok[1], left, right)
                continue
            break
        return left

    def unary(self):
        tok = self.peek()
        if tok == ("op", "-"):
            self.take()
            return ("neg", self.unary())
        if tok == ("op", "!"):
            self.take()
            return ("not", self.unary())
        if tok == ("op", "("):
            self.take()
            e = self.expr(0)
            self.take("op", ")")
            return e
        if tok[0] == "num":
            self.take()
            return ("num", tok[1])
        if tok[0] == "id":
            self.take()
            name = tok[1]
            if self.peek() == ("op", "("):
                if not name.startswith("math."):
                    raise MolangError(f"unknown function {name}")
                fn = name[5:]
                if fn not in MATH:
                    raise MolangError(f"unknown math function {name}")
                self.take()
                args = []
                if self.peek() != ("op", ")"):
                    args.append(self.expr(0))
                    while self.peek() == ("op", ","):
                        self.take()
                        args.append(self.expr(0))
                self.take("op", ")")
                return ("call", fn, args)
            if not (name.startswith("variable.") or name.startswith("query.") or name.startswith("temp.")):
                raise MolangError(f"unknown identifier {name}")
            return ("var", name)
        raise MolangError(f"unexpected {tok}")


def parse(src):
    p = Parser(str(src))
    prog = p.program()
    p.take("eof")
    return prog


class Ctx:
    def __init__(self, variables=None, rng=None):
        self.vars = dict(variables or {})
        self.rng = rng or random.Random(1)
        self.missing_reads = set()


def _num(v, name="value"):
    if v is MISSING:
        raise MolangError(f"read of unset {name}")
    return v


def ev(node, ctx):
    k = node[0]
    if k == "seq":
        val = 0.0
        for s in node[1]:
            val = ev(s, ctx)
        return val
    if k == "set":
        ctx.vars[node[1]] = _num(ev(node[2], ctx))
        return ctx.vars[node[1]]
    if k == "num":
        return node[1]
    if k == "var":
        name = node[1]
        if name in ctx.vars:
            return ctx.vars[name]
        # struct root present? (e.g. variable.dir when variable.dir.x exists)
        if any(n.startswith(name + ".") for n in ctx.vars):
            return 1.0
        ctx.missing_reads.add(name)
        return MISSING
    if k == "neg":
        return -_num(ev(node[1], ctx), "operand")
    if k == "not":
        return 0.0 if _num(ev(node[1], ctx)) else 1.0
    if k == "tern":
        return ev(node[2], ctx) if _num(ev(node[1], ctx)) else ev(node[3], ctx)
    if k == "bin":
        op = node[1]
        if op == "??":
            a = ev(node[2], ctx)
            if a is not MISSING:
                return a
            if node[3][0] == "block":
                ev(node[3][1], ctx)
                return 0.0
            return ev(node[3], ctx)
        a = _num(ev(node[2], ctx), "left operand")
        if op == "&&":
            return 1.0 if a and _num(ev(node[3], ctx)) else 0.0
        if op == "||":
            return 1.0 if a or _num(ev(node[3], ctx)) else 0.0
        b = _num(ev(node[3], ctx), "right operand")
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/":
            return a / b if b != 0 else 0.0
        return float({"<": a < b, ">": a > b, "<=": a <= b, ">=": a >= b, "==": a == b, "!=": a != b}[op])
    if k == "call":
        fn = node[1]
        args = [_num(ev(a, ctx), f"math.{fn} arg") for a in node[2]]
        r = ctx.rng
        if fn == "random":
            return r.uniform(args[0], args[1])
        if fn == "random_integer":
            return float(r.randint(int(round(args[0])), int(round(args[1]))))
        if fn == "clamp":
            return min(max(args[0], args[1]), args[2])
        if fn == "lerp":
            return args[0] + (args[1] - args[0]) * args[2]
        if fn == "pow":
            if args[0] < 0 and not float(args[1]).is_integer():
                return float("nan")
            return math.pow(args[0], args[1])
        if fn == "sqrt":
            return math.sqrt(args[0]) if args[0] >= 0 else float("nan")
        if fn == "sin":
            return math.sin(math.radians(args[0]))
        if fn == "cos":
            return math.cos(math.radians(args[0]))
        if fn == "floor":
            return float(math.floor(args[0]))
        if fn == "abs":
            return abs(args[0])
        if fn == "min":
            return min(args)
        if fn == "max":
            return max(args)
        if fn == "mod":
            return math.fmod(args[0], args[1]) if args[1] else 0.0
    raise MolangError(f"cannot evaluate {node}")


def evaluate(src, ctx):
    if isinstance(src, (int, float)):
        return float(src)
    v = ev(parse(src), ctx)
    return _num(v, f"result of {src!r}")
