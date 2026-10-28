import assert from "node:assert/strict";
import test from "node:test";
import { WslAdapter } from "../src/host.js";

function config() {
  return {
    adapterKind: "wsl",
    wslDistro: "Ubuntu",
    wslBin: "wsl.exe",
    tmuxBin: "tmux",
    ompBin: "omp",
    roots: ["/home/me/projects"],
    sessionEnv: { OMP_PROFILE: "work" },
    linkTimeoutMs: 1000,
    startTimeoutMs: 1000,
    terminalEnabled: false,
  };
}

function fakeAdapter() {
  const adapter = new WslAdapter(config());
  adapter.calls = [];
  adapter.runWsl = async (args) => {
    adapter.calls.push(args);
    if (args[0] === "wslpath") return { code: 0, stdout: "/mnt/c/state/overlay.yml\n", stderr: "" };
    if (args[0] === "test") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return adapter;
}

test("WSL adapter prefixes distro and separator", async () => {
  const adapter = fakeAdapter();
  await adapter.runOmp(["collab", "list", "--json"]);
  assert.deepEqual(adapter.calls[0].slice(0, 3), ["env", "OMP_PROFILE=work", "omp"]);
  assert.deepEqual(adapter.calls[0].slice(-3), ["collab", "list", "--json"]);
});

test("WSL adapter converts overlay paths and starts tmux", async () => {
  const adapter = fakeAdapter();
  await adapter.startSession({
    name: "omp-test",
    cwd: "/home/me/projects/app",
    overlayPath: "C:\\Users\\me\\.config\\omp-remote\\overlays\\omp-test.yml",
  });
  assert.deepEqual(adapter.calls[0], ["wslpath", "-a", "C:\\Users\\me\\.config\\omp-remote\\overlays\\omp-test.yml"]);
  const tmux = adapter.calls[1];
  assert.equal(tmux[0], "tmux");
  assert.equal(tmux[1], "new-session");
  assert.equal(tmux[2], "-d");
  assert.equal(tmux[3], "-s");
  assert.equal(tmux[4], "omp-test");
  assert.equal(tmux[5], "-c");
  assert.equal(tmux[6], "/home/me/projects/app");
  assert.equal(tmux[7], "bash");
  assert.equal(tmux[8], "-lc");
  assert.match(tmux[9], /^exec env OMP_PROFILE='work' 'omp' --config '\/mnt\/c\/state\/overlay.yml' --cwd '\/home\/me\/projects\/app'$/);
});

test("WSL adapter rejects paths outside roots before touching WSL", async () => {
  const adapter = fakeAdapter();
  await assert.rejects(() => adapter.validateCwd("/etc"), /outside allowed roots/);
  assert.equal(adapter.calls.length, 0);
});
