#!/usr/bin/env python3
"""Post-process drizzle-kit pull output (types only): map DB domains/bytea, neutralise complex SQL defaults, and make the
file deterministic and correct where drizzle-kit is not:
  * composite FKs: drizzle-kit sorts an FK's local and foreign column lists separately, so pairs come out wrong
    (e.g. import_job_mapping_profile_fk paired kind with id). Every foreignKey() is rebuilt from pg_constraint
    (unnest(conkey, confkey) WITH ORDINALITY), keyed by (schema, table, constraint name): constraint names are not
    unique across tables (sales/platform idempotency_key share theirs);
  * policies: drizzle-kit attaches USING / WITH CHECK to a random subset of a table's policies. The file is types-only,
    so the clauses are stripped (name / as / for / to stay);
  * each table's extras (pk, unique, indexes, FKs, checks, policies) are stable-sorted by kind, then name.
  * index operator classes: drizzle-kit guesses .op("<type>_ops") per column and the guess changes between DB builds
    (tag_rfid_epc_uq got text_ops on a uuid column after a rebuild). Every index here uses the default opclass and the file
    is types-only, so .op(...) is stripped.

usage: fix-drizzle.py SCHEMA_TS --fks FKS_TSV [--no-header]
  FKS_TSV: schema, table, conname, local cols, foreign schema, foreign table, foreign cols (tab separated, cols comma
  separated in key order) - scripts/db-pull.sh writes it from the introspected DB.
"""
import re, sys
args = sys.argv[1:]
if len(args) < 3 or args[1] != '--fks':
    sys.exit('usage: fix-drizzle.py SCHEMA_TS --fks FKS_TSV [--no-header]')
p, fks_path, header = args[0], args[2], '--no-header' not in args
s = open(p).read()
DOMAIN = {'platform.money': 'numeric', 'platform.weight_g': 'numeric', 'platform.rate': 'numeric', 'platform.pct': 'numeric',
          'bytea': 'bytea'}
def repl_unknown(m):
    typ, name = m.group(1), m.group(2)
    base = DOMAIN.get(typ, 'text')
    return f'{base}("{name}"'
s = re.sub(r'// TODO: failed to parse database type \'([^\']+)\'\n\s*(\w+): unknown\("([^"]+)"',
           lambda m: f'{m.group(2)}: ' + repl_unknown(type('M', (), {'group': lambda self, i: [None, m.group(1), m.group(3)][i]})()), s)
# drizzle-kit emits DEFAULT '' as .default(') (unterminated quote); repair before parsing
s = s.replace(".default(')", ".default('')")
# complex defaults -> sql`<db default>` (value irrelevant for types; DB applies its own default)
out, i = [], 0
while True:
    j = s.find('.default(', i)
    if j < 0: out.append(s[i:]); break
    out.append(s[i:j]); k = j + len('.default('); depth, q = 1, None
    while depth:
        c = s[k]
        if c == '\\': k += 2; continue
        if q:
            if c == q: q = None
        elif c in '\'"`': q = c
        elif c == '(': depth += 1
        elif c == ')': depth -= 1
        k += 1
    body = s[j + 9:k - 1]
    simple = re.fullmatch(r"\s*('([^'\\]|\\.)*'|-?\d+(\.\d+)?|true|false|\[\]|sql`[^`]*`)\s*", body)
    out.append(s[j:k] if simple else '.default(sql`db_default`)'); i = k
s = ''.join(out)
# break FK cycles (staff -> file -> app_user -> staff) that make tsc infer `any` (TS7022); types only, DB keeps the FK
CYCLE_FKS = ['staff_photo_file_fk']
for n in CYCLE_FKS:
    s = re.sub(r'\tforeignKey\(\{(?:(?!\}\),).)*?name: "' + re.escape(n) + r'"\s*\}\),\n', '', s, flags=re.S)
if 'bytea(' in s and 'const bytea' not in s:
    s = s.replace('\n', '\nimport { customType } from "drizzle-orm/pg-core";\nconst bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });\n', 1)


# index opclass guesses are unstable across DB builds (and often wrong); default opclasses everywhere -> drop them
s = re.sub(r'\.op\("[a-z0-9_]+"\)', '', s)

# ---------- structure: FK pairs from pg_constraint, policies without clauses, extras sorted ----------
FKS = {}
for line in open(fks_path).read().splitlines():
    if not line.strip():
        continue
    sch, tab, con, lc, fs, ft, fc = line.split('\t')
    FKS[(sch, tab, con)] = (lc.split(','), fs, ft, fc.split(','))

def split_items(body):
    """Top-level comma split of an array body (quotes / brackets aware)."""
    items, depth, q, start, i = [], 0, None, 0, 0
    while i < len(body):
        c = body[i]
        if q:
            if c == '\\': i += 2; continue
            if c == q: q = None
        elif c in '\'"`': q = c
        elif c in '([{': depth += 1
        elif c in ')]}': depth -= 1
        elif c == ',' and depth == 0:
            items.append(body[start:i].strip()); start = i + 1
        i += 1
    if body[start:].strip():
        items.append(body[start:].strip())
    return items

SCHEMAS = dict(re.findall(r'^export const (\w+) = pgSchema\("([^"]+)"\)', s, re.M))
TABLE_HEAD = re.compile(r'^export const (\w+) = (?:(\w+)\.table|pgTable)\("([^"]+)", \{$', re.M)
COL = re.compile(r'^\t(\w+): \w+\((?:"([^"]+)")?', re.M)
tables = {}       # (schema, table) -> (var, {db column -> property})
for m in TABLE_HEAD.finditer(s):
    sch = SCHEMAS.get(m.group(2), 'public') if m.group(2) else 'public'
    body = s[m.end():s.find('\n}', m.end())]
    tables[(sch, m.group(3))] = (m.group(1), {(c.group(2) or c.group(1)): c.group(1) for c in COL.finditer(body)})
camel = lambda n: re.sub(r'_([a-z0-9])', lambda x: x.group(1).upper(), n)

def fk_item(item, sch, tab):
    name = re.search(r'name: "([^"]+)"', item).group(1)
    fk = FKS.get((sch, tab, name))
    if not fk:
        sys.exit(f'fix-drizzle: FK {sch}.{tab}.{name} is not in pg_constraint ({fks_path})')
    lc, fs, ft, fc = fk
    own = tables[(sch, tab)][1]
    fref = re.search(r'foreignColumns: \[\s*(\w+)\.', item).group(1)       # table var as drizzle wrote it (or `table` for self refs)
    fcols = tables.get((fs, ft), (None, {}))[1]
    cols = ', '.join(f'table.{own.get(c, camel(c))}' for c in lc)
    fcol = ', '.join(f'{fref}.{fcols.get(c, camel(c))}' for c in fc)
    return f'foreignKey({{\n\t\t\tcolumns: [{cols}],\n\t\t\tforeignColumns: [{fcol}],\n\t\t\tname: "{name}"\n\t\t}})'

KIND = {'primaryKey': 0, 'unique': 1, 'uniqueIndex': 2, 'index': 3, 'foreignKey': 4, 'check': 5, 'pgPolicy': 6}
def item_key(it):
    k = re.match(r'(\w+)', it).group(1)
    n = re.search(r'name: "([^"]+)"', it) if k in ('foreignKey', 'primaryKey') else re.match(r'\w+\("([^"]+)"', it)
    return (KIND.get(k, 9), n.group(1) if n else it)
POLICY_CLAUSE = re.compile(r',\s*(?:using|withCheck): sql`[^`]*`')

def fix_table(m):
    head = m.group(0)
    hm = TABLE_HEAD.search(head)
    sch = SCHEMAS.get(hm.group(2), 'public') if hm.group(2) else 'public'
    tab = hm.group(3)
    k = head.find('}, (table) => [')
    if k < 0:
        return head
    pre, body = head[:k + len('}, (table) => [')], head[k + len('}, (table) => ['):-len('\n]);')]
    items = []
    for it in split_items(body):
        if it.startswith('foreignKey('):
            it = fk_item(it, sch, tab)
        elif it.startswith('pgPolicy('):
            it = re.sub(r'\s*\}\)$', ' })', POLICY_CLAUSE.sub('', it))
        items.append(it)
    items.sort(key=item_key)
    return pre + '\n' + ''.join(f'\t{x},\n' for x in items) + ']);'

s = re.sub(r'^export const \w+ = (?:\w+\.table|pgTable)\("[^"]+", \{$(?:(?!^export ).)*?^\]\);', fix_table, s, flags=re.M | re.S)
if header and not s.startswith('// GENERATED'):
    s = '// GENERATED by `pnpm db:pull` (drizzle-kit introspection + scripts/fix-drizzle.py). Types only; never generate migrations.\n' + s
open(p, 'w').write(s)
