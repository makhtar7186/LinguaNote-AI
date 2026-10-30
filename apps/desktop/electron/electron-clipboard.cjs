// Adapter between text-inserter.cjs and Electron's (asynchronous) clipboard. Free of Electron imports: the clipboard
// and the ClipboardItem class are injected, so the rules are unit-tested; the real behaviour was probed on Electron 45.
//
// What can be put back: the portable text formats. Windows also attaches raw entries to most copies
// ("electron application/osclipboard;format=\"DataObject\"" ...); those are application internals that cannot be
// rebuilt, so they are dropped on restore. But anything that carries real content we cannot restore (an image, files,
// a bitmap) makes the clipboard "not restorable": the caller then leaves it untouched.

const PORTABLE_TYPES = ["text/plain", "text/html", "text/rtf"];
const RAW_PREFIX = "electron application/osclipboard";
// Raw Windows formats that hold content the user would miss (files, pictures). Checked case-insensitively.
const RAW_CONTENT_FORMATS = [
  "filenamew", "filename", "shell idlist array", "filegroupdescriptor", "filecontents", "hdrop", "cf_hdrop",
  "bitmap", "dib", "dibv5", "png", "enhmetafile", "metafilepict",
];

function rawFormatName(type) {
  const match = /format="([^"]*)"/.exec(type);
  return match ? match[1].toLowerCase() : "";
}

/** `{ restorable, portable }` for a list of clipboard types. */
function classify(types) {
  const portable = types.filter((type) => PORTABLE_TYPES.includes(type));
  for (const type of types) {
    if (PORTABLE_TYPES.includes(type)) continue;
    if (type.startsWith(RAW_PREFIX)) {
      const name = rawFormatName(type);
      if (RAW_CONTENT_FORMATS.some((content) => name.includes(content))) return { restorable: false, portable };
      continue; // an application-internal entry: dropped on restore
    }
    return { restorable: false, portable }; // image/*, application/*, anything else that is real content
  }
  // Only internal entries and no text: nothing we could put back.
  return { restorable: types.length === 0 || portable.length > 0, portable };
}

function createElectronClipboardPort({ clipboard, ClipboardItem }) {
  return {
    /** null when the clipboard holds something that cannot be restored, `{ empty: true }`, or `{ parts }`. */
    async snapshot() {
      const items = await clipboard.read();
      const types = [...new Set(items.flatMap((item) => item.types))];
      if (types.length === 0) return { empty: true };
      const { restorable, portable } = classify(types);
      if (!restorable) return null;
      const parts = {};
      for (const type of portable) {
        const item = items.find((candidate) => candidate.types.includes(type));
        parts[type] = await (await item.getType(type)).text();
      }
      return { empty: false, parts };
    },

    async restore(snapshot) {
      if (snapshot.empty) return clipboard.clear();
      await clipboard.write([new ClipboardItem(snapshot.parts)]);
    },

    writeText: (text) => clipboard.writeText(text),
    readText: () => clipboard.readText(),
  };
}

module.exports = { createElectronClipboardPort, classify, PORTABLE_TYPES };
