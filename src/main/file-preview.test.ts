// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentMimeTypeForName } from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { filePreviewFromBytes, localFilePreview, mimeTypeForName } from "./file-preview";
import { filePreviewPages } from "./file-preview-pages";

const temporaryDirectories: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

afterEach(async () => {
  filePreviewPages.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("file previews", () => {
  it("does not register a page when its file read finishes after the renderer is replaced", async () => {
    const started = deferred<void>();
    const bytes = Buffer.from("<h1>Late preview</h1>");
    const read = deferred<typeof bytes>();
    vi.mocked(readFile).mockImplementationOnce(() => {
      started.resolve();
      return read.promise;
    });
    const preview = runCauseEffect(
      localFilePreview("/late.html", "late.html", bytes.length, filePreviewPages.generation),
    );
    await started.promise;
    filePreviewPages.clear();
    read.resolve(bytes);
    expect(await preview).not.toHaveProperty("pageUrl");
    expect(filePreviewPages.add("text/html", bytes, filePreviewPages.generation)).toBeDefined();
  });
  it.each(["report.html", "REPORT.HTM"])(
    "renders local %s while keeping attachment and remote MIME rules",
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), "openbot-html-preview-"));
      temporaryDirectories.push(directory);
      const bytes = new TextEncoder().encode("<h1>Local report</h1><script>drawChart()</script>");
      const path = join(directory, name);
      await writeFile(path, bytes);

      const preview = await runCauseEffect(localFilePreview(path, name, bytes.byteLength, filePreviewPages.generation));
      expect(preview.bytes).toEqual(bytes);
      expect(preview.mimeType).toBe("text/html");
      expect(preview.pageUrl).toBeDefined();
      expect(filePreviewPages.get(new URL(preview.pageUrl ?? ""))).toEqual(bytes);
      expect(mimeTypeForName(name)).toBe("text/plain");
      expect(attachmentMimeTypeForName(name)).toBe("text/plain");
      expect(filePreviewFromBytes(name, bytes)).toMatchObject({ mimeType: "text/plain", previewKind: "text" });
      expect(filePreviewFromBytes(name, bytes)).not.toHaveProperty("pageUrl");
      expect(filePreviewFromBytes("source.txt", bytes)).not.toHaveProperty("pageUrl");
    },
  );

  it("keeps HTML content in a local text file as source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openbot-text-preview-"));
    temporaryDirectories.push(directory);
    const bytes = new TextEncoder().encode("<h1>Text source</h1><script>drawChart()</script>");
    const path = join(directory, "source.txt");
    await writeFile(path, bytes);
    const preview = await runCauseEffect(
      localFilePreview(path, "source.txt", bytes.byteLength, filePreviewPages.generation),
    );
    expect(preview).toMatchObject({ mimeType: "text/plain", previewKind: "text", bytes });
    expect(preview).not.toHaveProperty("pageUrl");
  });

  it("rejects oversized previews before reading local content", async () => {
    await expect(
      runCauseEffect(
        localFilePreview(
          "/does/not/need/to/exist",
          "large.txt",
          ATTACHMENT_LIMITS.fileBytes + 1,
          filePreviewPages.generation,
        ),
      ),
    ).rejects.toThrow("100 MB");
  });
});
