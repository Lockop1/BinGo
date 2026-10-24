import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFallbackText, shareOrCopy, type ShareData } from "@/lib/share";

const DATA: ShareData = {
  title: "Friday",
  text: "Jake just completed Skyline Chili",
  url: "https://bingo.example/g/ABCD2345",
};

function stubNavigator(share?: (data: ShareData) => Promise<void>) {
  const writeText = vi.fn(async (text: string) => {
    void text;
  });
  vi.stubGlobal("navigator", { share, clipboard: { writeText } });
  return writeText;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyFallbackText", () => {
  it("is the message, a newline and the link by default", () => {
    expect(copyFallbackText(DATA)).toBe("Jake just completed Skyline Chili\nhttps://bingo.example/g/ABCD2345");
  });

  it("is the bare link for copy: url, or when there is no message", () => {
    expect(copyFallbackText(DATA, "url")).toBe(DATA.url);
    expect(copyFallbackText({ ...DATA, text: "  " })).toBe(DATA.url);
  });
});

describe("shareOrCopy", () => {
  it("copies the message and link where there is no share sheet", async () => {
    const writeText = stubNavigator();
    await expect(shareOrCopy(DATA)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${DATA.text}\n${DATA.url}`);
  });

  it("copies only the link when asked (the invite)", async () => {
    const writeText = stubNavigator();
    await expect(shareOrCopy(DATA, { copy: "url" })).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(DATA.url);
  });

  it("uses the share sheet when there is one; closing it copies nothing", async () => {
    const share = vi.fn(async () => {});
    const writeText = stubNavigator(share);
    await expect(shareOrCopy(DATA)).resolves.toBe("shared");
    expect(share).toHaveBeenCalledWith(DATA);

    share.mockRejectedValueOnce(new DOMException("closed", "AbortError"));
    await expect(shareOrCopy(DATA)).resolves.toBe("dismissed");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to copying the message when the share sheet fails", async () => {
    const writeText = stubNavigator(async () => {
      throw new DOMException("nope", "NotAllowedError");
    });
    await expect(shareOrCopy(DATA)).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledWith(`${DATA.text}\n${DATA.url}`);
  });
});
