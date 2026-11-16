// Consent to fetching speech-model weights. Free of Electron imports so it can be unit-tested.
//
// Accepting is remembered. Declining is not: without a model nothing can be transcribed, so the question comes back at
// the next launch rather than leaving the application broken with no way out.

function isAccepted(fs, file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).accepted === true;
  } catch {
    return false; // no decision yet, or an unreadable file: asking again is the safe answer
  }
}

/**
 * @param {{fs: typeof import("node:fs"), file: string, ask: () => Promise<boolean>}} deps
 */
function createModelConsent({ fs, file, ask }) {
  return {
    /** Variables to add to the service's environment. HF_HUB_OFFLINE makes a missing model fail instead of downloading. */
    async environment(env) {
      if (env.HF_HUB_OFFLINE) return {}; // the machine already has a policy: do not ask, do not override it
      if (isAccepted(fs, file)) return {};
      let accepted = false;
      try {
        accepted = (await ask()) === true;
      } catch {
        accepted = false; // no answer is not a yes
      }
      if (!accepted) return { HF_HUB_OFFLINE: "1" };
      try {
        fs.writeFileSync(file, JSON.stringify({ accepted: true }), "utf8");
      } catch {
        // Not remembered: the user is asked again next time. The answer given now still stands.
      }
      return {};
    },
  };
}

module.exports = { createModelConsent };
