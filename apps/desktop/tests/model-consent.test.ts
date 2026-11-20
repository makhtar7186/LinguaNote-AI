import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { createModelConsent } = createRequire(import.meta.url)("../electron/model-consent.cjs");

function fakeFs(initial?: string) {
  let content = initial;
  return {
    readFileSync: vi.fn(() => {
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    writeFileSync: vi.fn((_file: string, value: string) => { content = value; }),
  };
}

const setup = (ask: () => Promise<boolean>, initial?: string) => {
  const fs = fakeFs(initial);
  return { fs, consent: createModelConsent({ fs, file: "consent.json", ask }) };
};

describe("model download consent", () => {
  it("asks on first launch and allows the download once accepted, without asking again", async () => {
    const ask = vi.fn().mockResolvedValue(true);
    const { consent } = setup(ask);
    expect(await consent.environment({})).toEqual({});
    expect(await consent.environment({})).toEqual({});
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("forbids the download when declined, and asks again at the next launch", async () => {
    const ask = vi.fn().mockResolvedValue(false);
    const { consent, fs } = setup(ask);
    expect(await consent.environment({})).toEqual({ HF_HUB_OFFLINE: "1" });
    expect(await consent.environment({})).toEqual({ HF_HUB_OFFLINE: "1" });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("treats a dialog that fails as a refusal", async () => {
    const { consent } = setup(() => Promise.reject(new Error("no display")));
    expect(await consent.environment({})).toEqual({ HF_HUB_OFFLINE: "1" });
  });

  it.each(["not json", "{}", '{"accepted":"yes"}', '{"accepted":false}'])("does not read %s as consent", async (stored) => {
    const ask = vi.fn().mockResolvedValue(false);
    const { consent } = setup(ask, stored);
    expect(await consent.environment({})).toEqual({ HF_HUB_OFFLINE: "1" });
    expect(ask).toHaveBeenCalledOnce();
  });

  it("keeps the answer for this launch when it cannot be saved", async () => {
    const fs = fakeFs();
    fs.writeFileSync.mockImplementation(() => { throw new Error("EACCES"); });
    const consent = createModelConsent({ fs, file: "consent.json", ask: async () => true });
    expect(await consent.environment({})).toEqual({});
  });

  it("does not ask when the machine is already explicitly offline", async () => {
    const ask = vi.fn();
    const { consent } = setup(ask);
    expect(await consent.environment({ HF_HUB_OFFLINE: "1" })).toEqual({});
    expect(ask).not.toHaveBeenCalled();
  });
});
