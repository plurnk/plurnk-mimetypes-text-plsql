import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { PlSqlLexer } from "./generated/PlSqlLexer.ts";
import { PlSqlParser } from "./generated/PlSqlParser.ts";
import { PlSqlParserVisitor } from "./generated/PlSqlParserVisitor.ts";

// text/x-plsql handler. ANTLR grammar from grammars-v4/sql/plsql.
// Oracle's PL/SQL dialect.
//
// Parser entry rule: sql_script.
export default class TextPlsql extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new PlSqlLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new PlSqlParser(tokens);
        parser.removeErrorListeners();
        return parser.sql_script();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextPlsqlVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping:
//   CREATE TABLE name (cols)         → class; columns → field
//   CREATE VIEW name AS              → class
//   CREATE INDEX name ON table       → field
//   CREATE TRIGGER name              → method
//   CREATE PACKAGE name              → module (Oracle PACKAGEs are
//                                      module-like namespaces)
//   CREATE PACKAGE BODY name         → module
//   CREATE PROCEDURE name (args)     → function
//   CREATE FUNCTION name (args)      → function
//   CREATE TYPE name                 → type
//   CREATE SEQUENCE name             → field
//   CREATE SYNONYM name              → type (alias for another object)
//   DML statements                   → excluded
class TextPlsqlVisitor extends withExtractor(PlSqlParserVisitor) {
    visitCreate_table = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = ctx.table_name?.();
        const name = sqlNameText(tn);
        if (!name) return null;
        this.addSymbol("class", name, ctx);
        const cols = findDescendants(ctx, "Column_definitionContext");
        for (const col of cols) {
            const cn = (col as { column_name?: () => unknown }).column_name?.();
            const colName = sqlNameText(cn);
            if (colName) this.addSymbol("field", colName, ctx);
        }
        // Foreign keys are cross-table dependencies: this table USES every
        // table referenced by a FOREIGN KEY ... REFERENCES clause. The
        // referenced table is a tableview_name under references_clause —
        // distinct from this table's own table_name, so no self-reference.
        for (const fk of findDescendants(ctx, "Foreign_key_clauseContext")) {
            for (const tv of findDescendants(fk, "Tableview_nameContext")) {
                const fkName = tableRefName(tv);
                if (fkName) this.addRef("use", fkName, tv as never, { container: name });
            }
        }
        return null;
    };

    visitCreate_view = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._v);
        if (name) this.addSymbol("class", name, ctx);
        // A view USES every table its SELECT reads — the core SQL graph edge
        // (view → source tables). container = the view being created.
        if (name) this.refTableNames(ctx, name);
        return null;
    };

    visitCreate_index = (ctx: any): null => {
        if (this.inBody) return null;
        const inm = ctx.index_name?.();
        const name = sqlNameText(inm);
        if (name) this.addSymbol("field", name, ctx);
        // An index attaches to its ON table (the only tableview_name here).
        if (name) {
            const tv = findDescendants(ctx, "Tableview_nameContext")[0];
            const onName = tableRefName(tv);
            if (onName) this.addRef("use", onName, tv as never, { container: name });
        }
        return null;
    };

    visitCreate_trigger = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = ctx.trigger_name?.();
        const name = sqlNameText(tn);
        if (name) this.addSymbol("method", name, ctx);
        // A trigger references its ON table and every table its body touches.
        if (name) this.refTableNames(ctx, name);
        return null;
    };

    visitCreate_procedure_body = (ctx: any): null => {
        if (this.inBody) return null;
        const pn = ctx.procedure_name?.();
        const name = sqlNameText(pn);
        if (name) this.addSymbol("function", name, ctx);
        // A procedure USES every table its body reads/writes — a real Oracle
        // dependency edge (DML inside BEGIN...END).
        if (name) this.refTableNames(ctx, name);
        return null;
    };

    visitCreate_function_body = (ctx: any): null => {
        if (this.inBody) return null;
        const fn = ctx.function_name?.();
        const name = sqlNameText(fn);
        if (name) this.addSymbol("function", name, ctx);
        // A function USES every table its body queries.
        if (name) this.refTableNames(ctx, name);
        return null;
    };

    visitCreate_package = (ctx: any): null => {
        if (this.inBody) return null;
        const pns = collectChildren(ctx, "package_name");
        const name = sqlNameText(pns[0]);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreate_package_body = (ctx: any): null => {
        if (this.inBody) return null;
        const pns = collectChildren(ctx, "package_name");
        const name = sqlNameText(pns[0]);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreate_sequence = (ctx: any): null => {
        if (this.inBody) return null;
        const sn = ctx.sequence_name?.();
        const name = sqlNameText(sn);
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitCreate_type = (ctx: any): null => {
        if (this.inBody) return null;
        // CREATE TYPE name ... — the name lives inside type_definition or
        // type_body. Walk for the first type_name node.
        const td = ctx.type_definition?.();
        const tb = ctx.type_body?.();
        const sub = td ?? tb;
        if (!sub) return null;
        const tn = findDescendants(sub, "Type_nameContext")[0];
        const name = sqlNameText(tn);
        if (name) this.addSymbol("type", name, ctx);
        return null;
    };

    visitCreate_synonym = (ctx: any): null => {
        if (this.inBody) return null;
        const sns = collectChildren(ctx, "synonym_name");
        const name = sqlNameText(sns[0]);
        if (name) this.addSymbol("type", name, ctx);
        return null;
    };

    // Emit a `use` ref for every tableview_name descendant under `ctx`, owned
    // by the created object `container`. The created object's own name is a
    // view_name/trigger_name/procedure_name (distinct contexts that are NOT
    // tableview_name), so it never self-references; FK references are handled
    // separately in visitCreate_table.
    private refTableNames(ctx: unknown, container: string): void {
        for (const tv of findDescendants(ctx, "Tableview_nameContext")) {
            const tableName = tableRefName(tv);
            if (tableName) this.addRef("use", tableName, tv as never, { container });
        }
    }
}

function sqlNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
}

// tableview_name resolves to SCHEMA.TABLE (getText keeps the schema dot),
// whereas a CREATE TABLE def's table_name resolves to the bare identifier.
// Strip to the last dotted segment so refs join against local table defs.
function tableRefName(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    const segment = dot >= 0 ? raw.slice(dot + 1) : raw;
    return unquoteSqlIdentifier(segment);
}

function unquoteSqlIdentifier(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
    }
    return s;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}

function findDescendants(root: unknown, ctxName: string): unknown[] {
    const out: unknown[] = [];
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as {
            constructor?: { name?: string };
            getChildCount?: () => number;
            getChild?: (i: number) => unknown;
        };
        if (!node) continue;
        if (node.constructor?.name === ctxName) out.push(node);
        const count = node.getChildCount?.() ?? 0;
        for (let i = 0; i < count; i += 1) stack.push(node.getChild?.(i));
    }
    return out;
}
