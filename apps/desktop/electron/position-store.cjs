// Remembers where the user left the bubble. Only a position is stored (no audio, no text). `fs` is injected.
const path = require("node:path");
const { parseSavedPosition } = require("./bubble-geometry.cjs");

function createPositionStore(fs, file) {
  return {
    /** The saved position, or null when absent, unreadable or not a plain {x, y}. */
    load() {
      try {
        return parseSavedPosition(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    /** Best effort: failing to remember a position must never disturb dictation. */
    save({ x, y }) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ x: Math.round(x), y: Math.round(y) }), "utf8");
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createPositionStore };
