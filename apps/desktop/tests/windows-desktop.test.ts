import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { createWindowsDesktop, SCRIPT } = createRequire(import.meta.url)("../electron/windows-desktop.cjs");

type Callback = (error: Error | null, stdout: string) => void;
const fakeExec = (stdout: string, error: Error | null = null) =>
  vi.fn((_file: string, _args: string[], _options: unknown, callback: Callback) => callback(error, stdout));

describe("windows desktop", () => {
  it("reports the foreground window and whether it belongs to this process", async () => {
    const exec = fakeExec('{"id":"4242","title":"Bloc-notes","pid":77,"pasted":false}\r\n');
    const desktop = createWindowsDesktop({ ownPid: 99, execFileImpl: exec });
    expect(await desktop.foreground()).toEqual({ id: "4242", title: "Bloc-notes", own: false });
    const ours = createWindowsDesktop({ ownPid: 77, execFileImpl: exec });
    expect((await ours.foreground()).own).toBe(true);
  });

  it("treats a missing foreground window as unknown", async () => {
    const desktop = createWindowsDesktop({ execFileImpl: fakeExec('{"id":"0","title":"","pid":0,"pasted":false}') });
    expect(await desktop.foreground()).toBeNull();
  });

  it("passes the action and the expected window through the environment, never the text", async () => {
    const exec = fakeExec('{"id":"4242","title":"x","pid":1,"pasted":true}');
    const desktop = createWindowsDesktop({ execFileImpl: exec });
    expect(await desktop.paste("4242")).toEqual({ pasted: true });
    const options = exec.mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env.LINGUANOTE_ACTION).toBe("paste");
    expect(options.env.LINGUANOTE_EXPECTED_WINDOW).toBe("4242");
    expect(exec.mock.calls[0][1].join(" ")).not.toMatch(/Dakar|texte/);
  });

  it("only pastes when the script confirms it did", async () => {
    const desktop = createWindowsDesktop({ execFileImpl: fakeExec('{"id":"7","title":"autre","pid":1,"pasted":false}') });
    expect(await desktop.paste("4242")).toEqual({ pasted: false });
  });

  it("rejects when PowerShell fails or prints something unreadable", async () => {
    await expect(createWindowsDesktop({ execFileImpl: fakeExec("", new Error("boom")) }).foreground()).rejects.toThrow("desktop_script_failed");
    await expect(createWindowsDesktop({ execFileImpl: fakeExec("not json") }).foreground()).rejects.toThrow("desktop_script_unreadable");
  });

  it("checks the expected window before sending any key", () => {
    expect(SCRIPT.indexOf("$expected -eq $id")).toBeGreaterThan(-1);
    expect(SCRIPT.indexOf("$expected -eq $id")).toBeLessThan(SCRIPT.indexOf("SendWait"));
  });
});
