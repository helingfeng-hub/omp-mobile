import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const app = await createServer(config);

let addr;
try {
  addr = await app.start();
} catch (err) {
  console.error(`omp-mobile: failed to start: ${err?.message ?? err}`);
  process.exitCode = 1;
  throw err;
}

const host = addr.address === "0.0.0.0" || addr.address === "::" ? "127.0.0.1" : addr.address;
const url = `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
console.log(`omp-mobile ${config.version}`);
console.log(`listening: ${url}`);
console.log(`adapter:   ${app.adapter.name} (${config.platform})`);
console.log(`roots:     ${config.roots.join(", ")}`);
console.log(`token:     ${config.tokenCreated ? config.token : `stored in ${config.stateDir}/token`}`);
if (config.tokenCreated) {
  console.log("The token is shown once; the client stores it locally.");
}
console.log("Expose this loopback port with Tailscale Serve; do not port-forward it.");

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal}: stopping`);
  try {
    await app.stop();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
