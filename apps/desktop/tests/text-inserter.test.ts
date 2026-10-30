import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTextInserter } = createRequire(import.meta.url)("../electron/text-inserter.cjs");

const FAST = { lockDelayMs: 2, restoreDelayMs: 2, retryMs: 5 };

/** An async clipboard port like electron-clipboard.cjs: `formats` maps a MIME type to its content. */
class FakeClipboard {
  formats: Record<string, string> = {};
  writes: string[] = [];
  availableFormats() { return Object.keys(this.formats); }
  async snapshot(): Promise<{ empty: boolean; parts?: Record<string, string> } | null> {
    const types = Object.keys(this.formats);
    if (types.length === 0) return { empty: true };
    if (!types.every((type) => type.startsWith("text/"))) return null;
    return { empty: false, parts: { ...this.formats } };
  }
  async restore(snapshot: { empty: boolean; parts?: Record<string, string> }) {
    this.formats = snapshot.empty ? {} : { ...snapshot.parts };
  }
  async readText() { return this.formats["text/plain"] ?? ""; }
  async writeText(text: string) { this.formats = { "text/plain": text }; this.writes.push(text); }
}

class FakeDesktop {
  foregroundWindow: { id: string; title: string; own: boolean } | null = { id: "W1", title: "Bloc-notes", own: false };
  typed: string[] = [];
  pasteCalls = 0;
  clipboard: FakeClipboard;
  constructor(clipboard: FakeClipboard) { this.clipboard = clipboard; }
  async foreground() { return this.foregroundWindow; }
  async paste(expectedId: string) {
    this.pasteCalls += 1;
    if (this.foregroundWindow?.id !== expectedId) return { pasted: false };
    this.typed.push(await this.clipboard.readText()); // what Ctrl+V would insert
    return { pasted: true };
  }
}

let clipboard: FakeClipboard;
let desktop: FakeDesktop;
let statuses: { state: string; problem: { code: string } | null }[];
let inserter: ReturnType<typeof createTextInserter>;

function make(options = {}) {
  inserter = createTextInserter({
    clipboard, desktop, options: { ...FAST, ...options }, onStatus: (status: never) => statuses.push(status),
  });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
async function armed() {
  inserter.arm();
  await vi.waitFor(() => expect(inserter.status().state).toBe("on"));
}

beforeEach(() => {
  clipboard = new FakeClipboard();
  desktop = new FakeDesktop(clipboard);
  statuses = [];
  make();
});

describe("arming", () => {
  it("locks the window that is in front when the countdown ends", async () => {
    inserter.arm();
    expect(inserter.status().state).toBe("locking");
    await vi.waitFor(() => expect(inserter.status().state).toBe("on"));
    expect(inserter.status().target).toEqual({ title: "Bloc-notes" });
  });

  it("refuses to target LinguaNote itself", async () => {
    desktop.foregroundWindow = { id: "OURS", title: "LinguaNote AI", own: true };
    inserter.arm();
    await vi.waitFor(() => expect(inserter.status().state).toBe("off"));
    expect(inserter.status().problem?.code).toBe("target_is_self");
    expect(inserter.submit("texte")).toEqual({ accepted: false });
    await settle();
    expect(desktop.typed).toEqual([]);
  });

  it("stops when the foreground window cannot be identified", async () => {
    desktop.foregroundWindow = null;
    inserter.arm();
    await vi.waitFor(() => expect(inserter.status().state).toBe("off"));
    expect(inserter.status().problem?.code).toBe("target_unknown");
  });

  it("cannot be armed twice, and accepts no text before it is on", async () => {
    inserter.arm();
    expect(inserter.arm()).toMatchObject({ ok: false, code: "already_armed" });
    expect(inserter.submit("trop tôt")).toEqual({ accepted: false });
    await armed();
    await settle();
    expect(desktop.typed).toEqual([]);
  });

  it("a disarm during the countdown means nothing is ever locked or typed", async () => {
    inserter.arm();
    inserter.stop();
    await settle();
    expect(inserter.status().state).toBe("off");
    expect(inserter.status().target).toBeNull();
  });
});

describe("inserting", () => {
  it("inserts utterances in order, separated by a space, never with a leading one", async () => {
    await armed();
    inserter.submit("Bonjour");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["Bonjour"]));
    inserter.submit("tout le monde");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["Bonjour", " tout le monde"]));
    expect(inserter.status()).toMatchObject({ state: "on", pendingChars: 0 });
  });

  it("keeps the order when several utterances arrive faster than they can be inserted", async () => {
    await armed();
    for (const word of ["un", "deux", "trois", "quatre"]) inserter.submit(word);
    await vi.waitFor(() => expect(desktop.typed.join("").replace(/ /g, "")).toBe("undeuxtroisquatre"));
    expect(desktop.typed.join("")).toMatch(/^un/);
  });

  it("ignores empty or non-string text", async () => {
    await armed();
    for (const value of ["", "   ", null, undefined, 5]) expect(inserter.submit(value)).toEqual({ accepted: false });
    await settle();
    expect(desktop.pasteCalls).toBe(0);
  });
});

describe("the user's clipboard", () => {
  it("is put back after the paste (text, html and rtf)", async () => {
    clipboard.formats = { "text/plain": "mon texte", "text/html": "<b>mon texte</b>", "text/rtf": "{\\rtf1 mon}" };
    await armed();
    inserter.submit("dicté");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]));
    await vi.waitFor(() => expect(clipboard.formats).toEqual({
      "text/plain": "mon texte", "text/html": "<b>mon texte</b>", "text/rtf": "{\\rtf1 mon}",
    }));
  });

  it("is emptied again when it was empty", async () => {
    await armed();
    inserter.submit("dicté");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]));
    await vi.waitFor(() => expect(clipboard.availableFormats()).toEqual([]));
  });

  it("is left alone if the user copied something else in the meantime", async () => {
    await armed();
    const realPaste = desktop.paste.bind(desktop);
    desktop.paste = async (id: string) => {
      const outcome = await realPaste(id);
      await clipboard.writeText("copié par l’utilisateur"); // the user copies right after the paste
      return outcome;
    };
    inserter.submit("dicté");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]));
    await settle();
    expect(await clipboard.readText()).toBe("copié par l’utilisateur");
  });

  it("is never overwritten when it holds something that cannot be restored", async () => {
    clipboard.formats = { "image/png": "…pixels…" };
    await armed();
    inserter.submit("dicté");
    await vi.waitFor(() => expect(inserter.status().problem?.code).toBe("clipboard_not_restorable"));
    await settle();
    expect(clipboard.formats).toEqual({ "image/png": "…pixels…" });
    expect(clipboard.writes).toEqual([]);
    expect(desktop.typed).toEqual([]);
    // Once the clipboard is something we can restore, the waiting text goes through, nothing lost.
    clipboard.formats = { "text/plain": "retour au texte" };
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]));
    await vi.waitFor(async () => expect(await clipboard.readText()).toBe("retour au texte"));
  });

  it("is restored also when the paste did not happen", async () => {
    clipboard.formats = { "text/plain": "original" };
    await armed();
    desktop.foregroundWindow = { id: "W1", title: "Bloc-notes", own: false };
    desktop.paste = async () => ({ pasted: false });
    inserter.submit("dicté");
    await vi.waitFor(() => expect(inserter.status().problem?.code).toBe("target_left"));
    await vi.waitFor(async () => expect(await clipboard.readText()).toBe("original"));
  });
});

describe("failures are visible, never swallowed", () => {
  it("reports a clipboard that cannot be read, keeps the text and retries", async () => {
    await armed();
    const realSnapshot = clipboard.snapshot.bind(clipboard);
    let broken = true;
    clipboard.snapshot = async () => {
      if (broken) throw new Error("locked");
      return realSnapshot();
    };
    inserter.submit("dicté");
    await vi.waitFor(() => expect(inserter.status().problem?.code).toBe("insertion_failed"));
    expect(inserter.status().pendingChars).toBe(5);
    expect(desktop.typed).toEqual([]);
    broken = false;
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]), { timeout: 2000 });
    expect(inserter.status().problem).toBeNull();
  });

  it("tells the user when their clipboard could not be put back", async () => {
    clipboard.formats = { "text/plain": "original" };
    await armed();
    clipboard.restore = async () => { throw new Error("locked"); };
    inserter.submit("dicté");
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dicté"]));
    await vi.waitFor(() => expect(inserter.status().problem?.code).toBe("clipboard_restore_failed"));
    expect(inserter.status().pendingChars).toBe(0); // the text itself was inserted
  });
});

describe("leaving the target", () => {
  it("pauses, types nothing elsewhere, and resumes by itself when the user comes back", async () => {
    await armed();
    desktop.foregroundWindow = { id: "W2", title: "Navigateur", own: false };
    inserter.submit("pour le bloc-notes");
    await vi.waitFor(() => expect(inserter.status().problem?.code).toBe("target_left"));
    expect(inserter.status()).toMatchObject({ state: "paused", pendingChars: "pour le bloc-notes".length });
    expect(desktop.typed).toEqual([]);
    expect(desktop.pasteCalls).toBe(0); // not even attempted in the wrong window
    expect(clipboard.writes).toEqual([]); // and the clipboard was never touched

    inserter.submit("et la suite");
    desktop.foregroundWindow = { id: "W1", title: "Bloc-notes", own: false };
    await vi.waitFor(() => expect(desktop.typed).toEqual(["pour le bloc-notes et la suite"]));
    expect(inserter.status()).toMatchObject({ state: "on", problem: null, pendingChars: 0 });
  });

  it("stops accepting text beyond a limit rather than losing some silently", async () => {
    make({ maxPendingChars: 20 });
    await armed();
    desktop.foregroundWindow = { id: "W2", title: "Autre", own: false };
    expect(inserter.submit("0123456789")).toEqual({ accepted: true });
    expect(inserter.submit("0123456789ABC")).toMatchObject({ accepted: false, overflow: true });
    expect(inserter.status().problem?.code).toBe("pending_overflow");
  });

  it("a user disarm drops what was waiting and reports how much", async () => {
    await armed();
    desktop.foregroundWindow = { id: "W2", title: "Autre", own: false };
    inserter.submit("en attente");
    await vi.waitFor(() => expect(inserter.status().state).toBe("paused"));
    expect(inserter.stop()).toEqual({ ok: true, dropped: "en attente".length });
    desktop.foregroundWindow = { id: "W1", title: "Bloc-notes", own: false };
    await settle();
    expect(desktop.typed).toEqual([]); // the dropped text does not come back
  });
});

describe("end of the live session", () => {
  it("stops by itself when nothing waits", async () => {
    await armed();
    inserter.sessionEnded();
    expect(inserter.status().state).toBe("off");
  });

  it("finishes inserting what was accepted, then stops", async () => {
    await armed();
    inserter.submit("dernière phrase");
    inserter.sessionEnded();
    await vi.waitFor(() => expect(desktop.typed).toEqual(["dernière phrase"]));
    await vi.waitFor(() => expect(inserter.status().state).toBe("off"));
  });

  it("stays armed while text still waits for the user to come back", async () => {
    await armed();
    desktop.foregroundWindow = { id: "W2", title: "Autre", own: false };
    inserter.submit("en attente");
    await vi.waitFor(() => expect(inserter.status().state).toBe("paused"));
    inserter.sessionEnded();
    expect(inserter.status().state).toBe("paused");
    desktop.foregroundWindow = { id: "W1", title: "Bloc-notes", own: false };
    await vi.waitFor(() => expect(desktop.typed).toEqual(["en attente"]));
    await vi.waitFor(() => expect(inserter.status().state).toBe("off"));
  });
});
