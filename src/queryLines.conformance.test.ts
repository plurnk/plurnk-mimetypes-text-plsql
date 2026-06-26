import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextPlsql.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-plsql","glyph":"🔶","extensions":[".sql",".pls",".plsql"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "BEGIN NULL; END;\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
