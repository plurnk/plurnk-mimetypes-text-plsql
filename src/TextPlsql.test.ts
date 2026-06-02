import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlsql from "./TextPlsql.ts";

const metadata = {
    mimetype: "text/x-plsql",
    glyph: "🔶",
    extensions: [".sql", ".pls", ".plsql"] as const,
};

describe("TextPlsql — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextPlsql(metadata);
        assert.equal(h.mimetype, "text/x-plsql");
        assert.equal(h.glyph, "🔶");
    });
});

describe("TextPlsql — extract", () => {
    it("extracts CREATE TABLE + columns", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "CREATE TABLE users (",
            "    id NUMBER PRIMARY KEY,",
            "    name VARCHAR2(255) NOT NULL,",
            "    email VARCHAR2(255) UNIQUE,",
            "    created_at TIMESTAMP DEFAULT SYSDATE",
            ");",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "users" && s.kind === "class");
        assert.ok(t);
        assert.ok(syms.find((s) => s.name === "id"));
        assert.ok(syms.find((s) => s.name === "email"));
        assert.ok(syms.find((s) => s.name === "created_at"));
    });

    it("extracts CREATE VIEW", () => {
        const h = new TextPlsql(metadata);
        const src = "CREATE VIEW active_users AS SELECT * FROM users WHERE deleted_at IS NULL;";
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "active_users");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts CREATE INDEX", () => {
        const h = new TextPlsql(metadata);
        const src = "CREATE INDEX idx_users_email ON users (email);";
        const syms = h.extractRaw(src);
        const i = syms.find((s) => s.name === "idx_users_email");
        assert.ok(i);
        assert.equal(i.kind, "field");
    });

    it("extracts CREATE PROCEDURE", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "CREATE OR REPLACE PROCEDURE refresh_stats",
            "AS",
            "BEGIN",
            "    DBMS_STATS.GATHER_SCHEMA_STATS('APP');",
            "END refresh_stats;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "refresh_stats");
        assert.ok(p);
        assert.equal(p.kind, "function");
    });

    it("extracts CREATE FUNCTION", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "CREATE OR REPLACE FUNCTION add_one(x NUMBER) RETURN NUMBER",
            "AS",
            "BEGIN",
            "    RETURN x + 1;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "add_one");
        assert.ok(f);
        assert.equal(f.kind, "function");
    });

    it("extracts CREATE PACKAGE as module", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "CREATE OR REPLACE PACKAGE pkg_orders",
            "AS",
            "    PROCEDURE place_order(p_user_id NUMBER, p_item_id NUMBER);",
            "    FUNCTION total_for(p_user_id NUMBER) RETURN NUMBER;",
            "END pkg_orders;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "pkg_orders");
        assert.ok(p);
        assert.equal(p.kind, "module");
    });

    it("extracts CREATE SEQUENCE", () => {
        const h = new TextPlsql(metadata);
        const src = "CREATE SEQUENCE order_id_seq START WITH 1000;";
        const syms = h.extractRaw(src);
        const sq = syms.find((s) => s.name === "order_id_seq");
        assert.ok(sq);
        assert.equal(sq.kind, "field");
    });

    it("extracts CREATE TRIGGER", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "CREATE OR REPLACE TRIGGER touch_updated_at",
            "BEFORE UPDATE ON users",
            "FOR EACH ROW",
            "BEGIN",
            "    :NEW.updated_at := SYSDATE;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "touch_updated_at");
        assert.ok(t);
        assert.equal(t.kind, "method");
    });

    it("excludes DML statements", () => {
        const h = new TextPlsql(metadata);
        const src = [
            "INSERT INTO users (id, name) VALUES (1, 'a');",
            "UPDATE users SET name = 'b' WHERE id = 1;",
            "SELECT * FROM users;",
            "DELETE FROM users;",
            "CREATE TABLE t (id NUMBER);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["id", "t"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextPlsql(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextPlsql(metadata);
        assert.doesNotThrow(() => h.extractRaw("CREATE TABLE ( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });
});

describe("TextPlsql — framework integration", () => {
    it("renders extracted hierarchy via format()", () => {
        const h = new TextPlsql(metadata);
        const out = h.symbolsRaw("CREATE TABLE answers (id NUMBER);");
        assert.ok(out.includes("class answers"));
    });

    it("inherits jsonpath query against the symbol outline", async () => {
        const h = new TextPlsql(metadata);
        const src = "CREATE TABLE users (id NUMBER);";
        const t = await h.query(src, "jsonpath", "$.users");
        assert.equal(t.length, 1);
    });
});

// Real-world smoke against a representative Oracle PL/SQL package.
describe("TextPlsql — real-world smoke (orders-package shape)", () => {
    const SRC = [
        "CREATE TABLE orders (",
        "    id NUMBER PRIMARY KEY,",
        "    user_id NUMBER NOT NULL,",
        "    total NUMBER(10,2) NOT NULL,",
        "    created_at TIMESTAMP DEFAULT SYSDATE",
        ");",
        "",
        "CREATE INDEX idx_orders_user_id ON orders (user_id);",
        "",
        "CREATE SEQUENCE order_id_seq START WITH 1000;",
        "",
        "CREATE VIEW active_orders AS",
        "    SELECT * FROM orders WHERE created_at > SYSDATE - 30;",
        "",
        "CREATE OR REPLACE PACKAGE pkg_orders",
        "AS",
        "    PROCEDURE place_order(p_user_id NUMBER, p_total NUMBER);",
        "    FUNCTION total_for(p_user_id NUMBER) RETURN NUMBER;",
        "END pkg_orders;",
        "",
        "CREATE OR REPLACE PROCEDURE archive_old_orders",
        "AS",
        "BEGIN",
        "    DELETE FROM orders WHERE created_at < SYSDATE - 365;",
        "    COMMIT;",
        "END;",
        "",
        "CREATE OR REPLACE TRIGGER touch_orders_updated_at",
        "BEFORE UPDATE ON orders",
        "FOR EACH ROW",
        "BEGIN",
        "    :NEW.updated_at := SYSDATE;",
        "END;",
    ].join("\n");

    it("surfaces tables + columns + indexes + sequence + view + package + procedure + trigger", () => {
        const h = new TextPlsql(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("orders"));
        assert.ok(names.has("active_orders"));
        assert.ok(names.has("order_id_seq"));
        assert.ok(names.has("pkg_orders"));
        assert.ok(names.has("archive_old_orders"));
        assert.ok(names.has("touch_orders_updated_at"));

        assert.ok(names.has("user_id"));
        assert.ok(names.has("total"));
        assert.ok(names.has("idx_orders_user_id"));
    });

    it("kind discrimination", () => {
        const h = new TextPlsql(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("orders:class"));
        assert.ok(byNameKind.has("active_orders:class"));
        assert.ok(byNameKind.has("pkg_orders:module"));
        assert.ok(byNameKind.has("archive_old_orders:function"));
        assert.ok(byNameKind.has("touch_orders_updated_at:method"));
    });
});
