import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { parseTmuxSessions } from "../src/host.js";
import { findHostForSession, pickHost, validateCollabUrl } from "../src/collab.js";
import { isWithinRoots, normalizeRoots, shellQuote } from "../src/util.js";

test("shellQuote survives single quotes", () => {
  const values = ["hello", "a b", "it's", "'", "", "$(touch /tmp/nope)"];
  for (const value of values) {
    const output = execFileSync("bash", ["-lc", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" });
    assert.equal(output, value);
  }
});

test("isWithinRoots rejects traversal and sibling prefixes", () => {
  const root = path.resolve("/tmp/omp-root");
  assert.equal(isWithinRoots(root, [root]), true);
  assert.equal(isWithinRoots(path.join(root, "a/b"), [root]), true);
  assert.equal(isWithinRoots(path.join(root, "..", "etc"), [root]), false);
  assert.equal(isWithinRoots(`${root}-sibling`, [root]), false);
});

test("normalizeRoots resolves and deduplicates", () => {
  const roots = normalizeRoots(["/tmp/a", "/tmp/a/", "/tmp/b"]);
  assert.deepEqual(roots, ["/tmp/a", "/tmp/b"]);
});

test("parseTmuxSessions filters the omp prefix and parses metadata", () => {
  const stdout = [
    "omp-aaaa\t1700000000\t101\t1\t/tmp/a",
    "other\t1700000001\t102\t0\t/tmp/b",
    "omp-bbbb\t1700000002\t103\t0\t/tmp/c",
  ].join("\n");
  const sessions = parseTmuxSessions(stdout, "omp-");
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].name, "omp-bbbb");
  assert.equal(sessions[0].createdAt, 1700000002000);
  assert.equal(sessions[0].attached, false);
  assert.equal(sessions[1].name, "omp-aaaa");
});

test("pickHost chooses the newest matching host and respects exclusions", () => {
  const hosts = [
    { instanceId: "old", generation: 1, cwd: "/tmp", startedAt: 1000 },
    { instanceId: "new", generation: 2, cwd: "/tmp", startedAt: 5000 },
    { instanceId: "other", generation: 1, cwd: "/var", startedAt: 9000 },
  ];
  assert.equal(pickHost(hosts, { cwd: "/tmp" }).instanceId, "new");
  assert.equal(pickHost(hosts, { cwd: "/tmp", exclude: new Set(["new"]) }).instanceId, "old");
  assert.equal(pickHost(hosts, { cwd: "/tmp", since: 11000 }), null);
  assert.equal(pickHost(hosts, { cwd: "/var" }).instanceId, "other");
});

test("findHostForSession keeps a tmux session bound to its own omp pid", () => {
  const hosts = [
    { instanceId: "history", generation: 10, pid: 3497928, cwd: "/w", startedAt: 5000 },
    { instanceId: "fresh", generation: 1, pid: 3530114, cwd: "/w", startedAt: 9000 },
  ];
  // Newer startedAt belongs to the other session; pid must win.
  assert.equal(findHostForSession(hosts, { pid: 3497928, cwd: "/w" }).instanceId, "history");
  assert.equal(findHostForSession(hosts, { pid: 3530114, cwd: "/w" }).instanceId, "fresh");
});

test("findHostForSession follows a re-hosted generation for the same pid", () => {
  const hosts = [{ instanceId: "own", generation: 11, pid: 42, cwd: "/w", startedAt: 100 }];
  const host = findHostForSession(hosts, { pid: 42, instanceId: "own", generation: 9, cwd: "/w" });
  assert.equal(host.generation, 11);
});

test("findHostForSession falls back to the timestamp heuristic without a pid", () => {
  const hosts = [
    { instanceId: "old", generation: 1, pid: 1, cwd: "/w", startedAt: 1000 },
    { instanceId: "new", generation: 1, pid: 2, cwd: "/w", startedAt: 5000 },
  ];
  assert.equal(findHostForSession(hosts, { cwd: "/w" }).instanceId, "new");
  assert.equal(findHostForSession(hosts, { pid: 99, cwd: "/w" }).instanceId, "new");
  assert.equal(findHostForSession(hosts, { pid: 99, cwd: "/w", exclude: new Set(["new"]) }).instanceId, "old");
  assert.equal(findHostForSession(hosts, { pid: 99, cwd: "/x" }), null);
});

test("validateCollabUrl only accepts HTTPS or localhost HTTP", () => {
  assert.equal(validateCollabUrl("https://my.omp.sh/#room.key"), "https://my.omp.sh/#room.key");
  assert.equal(validateCollabUrl("http://localhost:3000/#room.key"), "http://localhost:3000/#room.key");
  assert.equal(validateCollabUrl("http://127.0.0.1:3000/#room.key"), "http://127.0.0.1:3000/#room.key");
  assert.throws(() => validateCollabUrl("http://example.com/#room.key"), /non-HTTPS/);
  assert.throws(() => validateCollabUrl("javascript:alert(1)"), /invalid|non-HTTPS/);
});
