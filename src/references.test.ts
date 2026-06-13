import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextPlsql from "./TextPlsql.ts";

const h = () =>
    new TextPlsql({ mimetype: "text/x-plsql", glyph: "🔶", extensions: [".sql", ".pls", ".plsql"] as const });

const SQL = `-- CommentDecoy: not a table
CREATE TABLE users (
  id NUMBER PRIMARY KEY,
  name VARCHAR2(255) DEFAULT 'StringDecoy'
);
CREATE TABLE orders (
  id NUMBER PRIMARY KEY,
  user_id NUMBER,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE VIEW active_orders AS
  SELECT o.id, u.name FROM orders o JOIN users u ON u.id = o.user_id;
CREATE INDEX idx_user ON orders (user_id);
CREATE OR REPLACE PROCEDURE archive_orders AS
BEGIN
  DELETE FROM orders WHERE id < 1;
  INSERT INTO audit_log VALUES (1);
END;
CREATE OR REPLACE FUNCTION count_orders RETURN NUMBER AS
  v NUMBER;
BEGIN
  SELECT COUNT(*) INTO v FROM orders;
  RETURN v;
END;
CREATE OR REPLACE TRIGGER trg_audit
AFTER INSERT ON orders
FOR EACH ROW
BEGIN
  INSERT INTO audit_log VALUES (1);
END;
`;

describe("text/x-plsql references (ANTLR refs grind)", () => {
    it("emits the SQL dependency graph with conformance invariants", async () => {
        const handler = h();
        const symbols = await handler.extractRaw(SQL);
        const refs = await handler.references(SQL);
        const defNames = new Set(symbols.map((s) => s.name));

        assert.ok(refs.length > 0, "produces refs");
        // Invariants (mirror the framework conformance harness).
        for (const r of refs) {
            assert.ok(r.line >= 1 && r.column >= 1, `1-indexed: ${r.name}`);
            assert.equal(typeof r.endColumn, "number");
            assert.equal(r.kind, "use", "SQL refs are declared dependencies");
            // No string-literal / comment leakage.
            assert.notEqual(r.name, "StringDecoy");
            assert.notEqual(r.name, "CommentDecoy");
        }

        // The graph edges, by container (the created object) → used table.
        const edge = (container: string, name: string) =>
            refs.some((r) => r.container === container && r.name === name);

        // View reads its source tables.
        assert.ok(edge("active_orders", "orders"), "view → orders");
        assert.ok(edge("active_orders", "users"), "view → users");
        // FK dependency.
        assert.ok(edge("orders", "users"), "orders FK → users");
        // Index attaches to its table.
        assert.ok(edge("idx_user", "orders"), "index → orders");
        // Procedure body references its tables.
        assert.ok(edge("archive_orders", "orders"), "procedure → orders");
        assert.ok(edge("archive_orders", "audit_log"), "procedure body → audit_log");
        // Function body references its tables.
        assert.ok(edge("count_orders", "orders"), "function → orders");
        // Trigger references its ON table + body tables.
        assert.ok(edge("trg_audit", "orders"), "trigger → orders");
        assert.ok(edge("trg_audit", "audit_log"), "trigger body → audit_log");

        // Join proof: the view/FK edges resolve to local table defs.
        assert.ok(defNames.has("users") && defNames.has("orders"));
        // A def's own name never appears as a ref (no self-reference).
        assert.ok(!refs.some((r) => r.name === r.container));
    });

    it("normalizes schema-qualified and quoted table refs to join local defs", async () => {
        const handler = h();
        const src = [
            "CREATE TABLE HR.EMPLOYEES (id NUMBER);",
            "CREATE VIEW emp_view AS SELECT * FROM HR.EMPLOYEES;",
            'CREATE TABLE "MixedCase" (id NUMBER);',
            'CREATE VIEW mc_view AS SELECT * FROM "MixedCase";',
        ].join("\n");
        const symbols = await handler.extractRaw(src);
        const refs = await handler.references(src);
        const defNames = new Set(symbols.map((s) => s.name));

        // Schema is stripped to the bare object name (matches table_name defs).
        assert.ok(refs.some((r) => r.container === "emp_view" && r.name === "EMPLOYEES"));
        assert.ok(defNames.has("EMPLOYEES"));
        // Quoted identifiers are unquoted on both def and ref sides.
        assert.ok(refs.some((r) => r.container === "mc_view" && r.name === "MixedCase"));
        assert.ok(defNames.has("MixedCase"));
        // The schema qualifier never leaks into the ref name.
        assert.ok(!refs.some((r) => r.name.includes(".")));
    });
});
