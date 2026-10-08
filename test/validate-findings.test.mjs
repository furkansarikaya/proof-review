import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { validate, checkReproductionPaths } from "../skills/proof-review/scripts/validate-findings.mjs";

const SCRIPT = new URL("../skills/proof-review/scripts/validate-findings.mjs", import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(new URL("../skills/proof-review/schema/findings.schema.json", import.meta.url)));

const loc = { file: "src/shop.ts", line: 12 };
const doc = () => ({
  schema_version: 1, skill_version: "0.0.1", generated_at: "2026-10-08T12:00:00Z",
  target: { type: "branch", name: "feature/discount", slug: "feature-discount", base: "aaa111", head: "bbb222" },
  scope: { changed_files: 2, changed_lines: 40, excluded: ["package-lock.json"], not_reviewed: [{ path: "docs/", reason: "docs only" }], rule_files_read: ["CLAUDE.md"], rule_files_not_read: [] },
  claims: [
    { id: "C001", text: "codes are case-insensitive", source: "user", status: "done", locations: [loc] },
    { id: "C002", text: "old endpoint removed", source: "commit", status: "partial", locations: [loc], missing_part: "route still registered" },
    { id: "C003", text: "adds audit log", source: "issue", status: "missing", locations: [] },
  ],
  rules: [{ id: "R001", rule: "No business logic in controllers", source: { file: "CLAUDE.md", line: 7 }, location: loc, violation: "The handler computes the discount itself." }],
  unrequested: [{ id: "U001", files: ["src/log.ts"], description: "Adds request logging." }],
  bugs: [
    { id: "F001", evidence: "reproduced", location: loc, input: "save10", expected: "90", actual: "100",
      impact: "A customer typing the code in lowercase pays full price.",
      reproduction: { file: "evidence/F001/repro.test.ts", command: "npx vitest run evidence/F001/repro.test.ts", output: "evidence/F001/output.txt" },
      status: "open" },
    { id: "F002", evidence: "traced", location: loc, input: "empty cart", expected: "0", actual: "NaN",
      impact: "An empty cart shows NaN to the customer.",
      trace: ["src/shop.ts:10 total starts undefined", "src/shop.ts:14 undefined + 0 yields NaN"], status: "open" },
  ],
  suspicions: [{ id: "S001", location: loc, reason: "unbounded retry", why_unproven: "no failing input found" }],
});

const tmpDirs = [];
const mktmp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function fixture(d = doc(), { files = ["evidence/F001/repro.test.ts", "evidence/F001/output.txt"] } = {}) {
  const dir = mktmp("proof-review-test-");
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  writeFileSync(join(dir, "findings.json"), JSON.stringify(d));
  return dir;
}
const all = (d, dir) => [...validate(d), ...(dir ? checkReproductionPaths(d, dir) : [])].join("\n");

test("valid document passes, including the CLI", () => {
  const dir = fixture();
  assert.equal(all(doc(), dir), "");
  const out = execFileSync("node", [SCRIPT, join(dir, "findings.json")], { encoding: "utf8" });
  assert.match(out, /^OK:/);
});

test("CLI exits 1 with one line per error", () => {
  const d = doc(); d.bugs[0].impact = "";
  const dir = fixture(d);
  const r = spawnSync("node", [SCRIPT, join(dir, "findings.json")], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INVALID/);
  assert.match(r.stderr, /bugs\[0\]\.impact/);
});

test("reproduced bug without reproduction fails", () => {
  const d = doc(); delete d.bugs[0].reproduction;
  assert.match(all(d), /requires "reproduction"/);
});

test("traced bug with 1 step fails; traced with reproduction fails", () => {
  let d = doc(); d.bugs[1].trace = ["only one"];
  assert.match(all(d), /at least 2 steps/);
  d = doc(); d.bugs[1].reproduction = doc().bugs[0].reproduction;
  assert.match(all(d), /allowed only when evidence is reproduced/);
});

test("partial without missing_part fails; missing_part on done fails", () => {
  let d = doc(); delete d.claims[1].missing_part;
  assert.match(all(d), /missing_part: required/);
  d = doc(); d.claims[0].missing_part = "x";
  assert.match(all(d), /missing_part: allowed only when status is partial/);
});

test("done claim needs a location; missing claim may have none", () => {
  const d = doc(); d.claims[0].locations = [];
  assert.match(all(d), /at least 1 location/);
});

test("duplicate id fails", () => {
  const d = doc(); d.bugs[1].id = "F001";
  assert.match(all(d), /duplicate id F001/);
});

test("wrong id prefix fails", () => {
  const d = doc(); d.bugs[1].id = "C002";
  assert.match(all(d), /id must match \^F/);
});

test("bad enums fail", () => {
  let d = doc(); d.claims[0].status = "finished";
  assert.match(all(d), /status: must be one of/);
  d = doc(); d.bugs[0].evidence = "guessed";
  assert.match(all(d), /evidence: must be one of/);
  d = doc(); d.target.type = "tag";
  assert.match(all(d), /target\.type: must be one of/);
});

test("severity field is rejected", () => {
  const d = doc(); d.bugs[0].severity = "high";
  assert.match(all(d), /unexpected "severity"/);
});

test("empty impact fails", () => {
  const d = doc(); d.bugs[1].impact = "  ";
  assert.match(all(d), /impact: expected non-empty string/);
});

test("working_tree needs null head; branch needs a head", () => {
  let d = doc(); d.target = { type: "working_tree", name: "working-tree", slug: "working-tree", base: "aaa", head: "bbb" };
  assert.match(all(d), /head: must be null/);
  d = doc(); d.target.head = null;
  assert.match(all(d), /head: expected non-empty string/);
});

test("path escape fails: .. and absolute", () => {
  let d = doc(); d.bugs[0].reproduction.file = "../secret.txt";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
  d = doc(); d.bugs[0].reproduction.output = "/etc/passwd";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
});

test("symlink out of the output folder fails", () => {
  const outside = mktmp("proof-review-outside-");
  writeFileSync(join(outside, "o.txt"), "x");
  const dir = fixture();
  symlinkSync(join(outside, "o.txt"), join(dir, "evidence", "F001", "link.txt"));
  const d = doc(); d.bugs[0].reproduction.output = "evidence/F001/link.txt";
  assert.match(all(d, dir), /resolves outside the output folder/);
});

test("missing evidence file fails", () => {
  const d = doc();
  const dir = fixture(d, { files: ["evidence/F001/repro.test.ts"] });
  assert.match(all(d, dir), /reproduction output not found/);
});

test("schema file parses and mirrors the validator's enums", () => {
  assert.deepEqual(SCHEMA.properties.bugs.items.properties.evidence.enum, ["reproduced", "traced"]);
  assert.equal(SCHEMA.properties.bugs.items.properties.severity, undefined);
  assert.ok(SCHEMA.required.includes("rules"));
  assert.ok(SCHEMA.properties.scope.required.includes("rule_files_not_read"));
});

test("document with a rules record passes; empty rules array passes", () => {
  assert.equal(all(doc()), "");
  const d = doc(); d.rules = [];
  assert.equal(all(d), "");
});

test("rule without a verbatim quote fails", () => {
  const d = doc(); d.rules[0].rule = " ";
  assert.match(all(d), /rules\[0\]\.rule: expected non-empty string/);
  const e = doc(); delete e.rules[0].rule;
  assert.match(all(e), /missing required "rule"/);
});

test("bad R id and wrong prefix in rules fail", () => {
  let d = doc(); d.rules[0].id = "R1";
  assert.match(all(d), /id must match \^R/);
  d = doc(); d.rules[0].id = "F001";
  assert.match(all(d), /id must match \^R/);
});

test("rules source and location need line >= 1", () => {
  const d = doc(); d.rules[0].source.line = 0;
  assert.match(all(d), /rules\[0\]\.source\.line/);
});

test("missing scope.rule_files_not_read or rules array fails", () => {
  let d = doc(); delete d.scope.rule_files_not_read;
  assert.match(all(d), /missing required "rule_files_not_read"/);
  d = doc(); delete d.rules;
  assert.match(all(d), /missing required "rules"/);
});

test("Windows drive-letter path fails", () => {
  const d = doc(); d.bugs[0].reproduction.file = "C:\\Users\\x\\repro.ts";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
  d.bugs[0].reproduction.file = "C:repro.ts";
  assert.match(all(d, fixture(d)), /escapes the output folder/);
});

test("a directory is not accepted as reproduction file or output", () => {
  const d = doc(); d.bugs[0].reproduction.file = "evidence/F001";
  assert.match(all(d, fixture(d)), /is not a file/);
});

test("slug must not start with a dot", () => {
  for (const slug of [".", "..", ".hidden"]) {
    const d = doc(); d.target.slug = slug;
    assert.match(all(d), /target\.slug/);
  }
  assert.match(SCHEMA.properties.target.properties.slug.pattern, /\(\?!\\\.\)/);
});

test("CLI runs through a symlinked skill folder", () => {
  const link = join(mktmp("proof-review-link-"), "skill");
  symlinkSync(new URL("../skills/proof-review", import.meta.url).pathname, link);
  const script = join(link, "scripts", "validate-findings.mjs");
  const bad = join(fixture({}), "findings.json");
  const r = spawnSync("node", [script, bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INVALID/);
  const ok = spawnSync("node", [script, join(fixture(), "findings.json")], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^OK:/);
});

test("working_tree target passes; wrong slug fails on the slug rule only", () => {
  const d = doc(); d.target = { type: "working_tree", name: "working-tree", slug: "working-tree", base: "aaa", head: null };
  assert.equal(all(d), "");
  d.target.slug = "other";
  assert.equal(validate(d).length, 1);
  assert.match(all(d), /target\.slug: must be working-tree/);
});

test("pr target passes with pr-N slug; fails with another slug", () => {
  const d = doc(); d.target = { type: "pr", name: "#12", slug: "pr-12", base: "aaa", head: "bbb" };
  assert.equal(all(d), "");
  d.target.slug = "feature-x";
  assert.match(all(d), /target\.slug: must match \^pr-/);
});

test("reproduced bug with trace fails; traced bug without trace fails", () => {
  let d = doc(); d.bugs[0].trace = ["a", "b"];
  assert.match(all(d), /bugs\[0\]\.trace: allowed only when evidence is traced/);
  d = doc(); delete d.bugs[1].trace;
  assert.match(all(d), /requires "trace"/);
});

test("single-field mutations fail with the field path", () => {
  const cases = [
    ["$.schema_version", (d) => { d.schema_version = 2; }],
    ["$.generated_at", (d) => { d.generated_at = "yesterday"; }],
    ["$.scope.changed_files", (d) => { d.scope.changed_files = -1; }],
    ["$.scope.changed_lines", (d) => { d.scope.changed_lines = 1.5; }],
    ["$.unrequested[0].files", (d) => { d.unrequested[0].files = []; }],
    ["$.suspicions[0].why_unproven", (d) => { d.suspicions[0].why_unproven = ""; }],
    ["$.bugs[0].location.line", (d) => { d.bugs[0].location.line = 2.5; }],
    ["$.scope.not_reviewed[0].reason", (d) => { delete d.scope.not_reviewed[0].reason; }],
    ["$.bugs[0].impact", (d) => { d.bugs[0].impact = "   "; }],
  ];
  for (const [path, mutate] of cases) {
    const d = doc(); mutate(d);
    const errs = validate(d);
    assert.ok(errs.length > 0, `${path} should fail`);
    assert.ok(errs.some((e) => e.includes(path) || e.includes(path.replace(/\.reason$/, ""))), `${path} not in: ${errs.join("; ")}`);
  }
});

test("CLI exits 2 without arguments and for a nonexistent file", () => {
  assert.equal(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status, 2);
  const r = spawnSync("node", [SCRIPT, join(mktmp("proof-review-none-"), "nope.json")], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
