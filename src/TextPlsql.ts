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
        return null;
    };

    visitCreate_view = (ctx: any): null => {
        if (this.inBody) return null;
        const name = sqlNameText(ctx._v);
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitCreate_index = (ctx: any): null => {
        if (this.inBody) return null;
        const inm = ctx.index_name?.();
        const name = sqlNameText(inm);
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitCreate_trigger = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = ctx.trigger_name?.();
        const name = sqlNameText(tn);
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };

    visitCreate_procedure_body = (ctx: any): null => {
        if (this.inBody) return null;
        const pn = ctx.procedure_name?.();
        const name = sqlNameText(pn);
        if (name) this.addSymbol("function", name, ctx);
        return null;
    };

    visitCreate_function_body = (ctx: any): null => {
        if (this.inBody) return null;
        const fn = ctx.function_name?.();
        const name = sqlNameText(fn);
        if (name) this.addSymbol("function", name, ctx);
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
}

function sqlNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
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
