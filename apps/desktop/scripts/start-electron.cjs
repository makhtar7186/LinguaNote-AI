// Starts the Electron application with a clean environment.
//
// ELECTRON_RUN_AS_NODE=1 is set by editors built on Electron (and inherited by tools they start). With it, the
// Electron binary behaves like plain Node and `require("electron")` returns nothing, so the app crashes at
// start. It must never reach the application.
const { spawn } = require("node:child_process");
const path = require("node:path");

/** Environment for the child application: the current one, minus the variables that change Electron's mode. */
function cleanEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** `executable`: an installed application, which needs no path to the application folder. */
function startElectron({ extraEnv, stdio = "inherit", executable } = {}) {
  const env = cleanEnvironment(extraEnv);
  if (executable) return spawn(executable, [], { stdio, env });
  const electronBinary = require("electron"); // the package exports the path of the binary
  return spawn(electronBinary, [path.join(__dirname, "..")], { stdio, env });
}

module.exports = { cleanEnvironment, startElectron };

if (require.main === module) {
  const child = startElectron();
  child.on("exit", (code) => process.exit(code ?? 0));
}
