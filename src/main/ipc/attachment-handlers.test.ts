// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateFor } from "@openbot/i18n";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filePreviewPages } from "../file-preview-pages";

type Invoke = (event: { senderFrame: { url: string } }, payload: unknown) => Promise<void>;
const { bound, saveDialog, openPath, showItemInFolder, userData } = vi.hoisted(() => ({
  bound: new Map<string, Invoke>(),
  saveDialog: vi.fn<(options?: unknown) => Promise<{ canceled: boolean; filePath?: string }>>(),
  openPath: vi.fn(async (_path: string) => ""),
  showItemInFolder: vi.fn((_path: string) => undefined),
  userData: { path: "" },
}));
vi.mock("electron", () => ({
  app: { getPath: () => userData.path || tmpdir() },
  dialog: { showSaveDialog: saveDialog },
  shell: { openPath, showItemInFolder },
  ipcMain: { handle: (channel: string, invoke: Invoke) => bound.set(channel, invoke) },
}));
const { attachmentIpcHandlers } = await import("./attachment-handlers");
const directories: string[] = [];
afterEach(async () => {
  filePreviewPages.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("local HTML preview requests", () => {
  it.each(["previewWorkspaceFile", "previewSharedFile"] as const)(
    "%s does not register an old request after file resolution crosses a renderer reload",
    async (endpoint) => {
      const directory = await mkdtemp(join(tmpdir(), "attachment-preview-"));
      directories.push(directory);
      const bytes = new TextEncoder().encode("<h1>Workspace preview</h1>");
      const path = join(directory, "preview.html");
      await writeFile(path, bytes);
      const started = deferred<void>();
      const resolved = deferred<void>();
      const file = { path, name: "preview.html", size: bytes.byteLength, insideWorkspace: true };
      const resolveFile = vi.fn(() =>
        Effect.promise(async () => {
          started.resolve();
          await resolved.promise;
          return file;
        }),
      );
      const handlers = attachmentIpcHandlers({
        getMainWindow: () => null,
        translate: translateFor("en"),
        service: {
          prepareAttachments: vi.fn(),
          prepareImportedAttachments: vi.fn(),
          discardDraftAttachment: vi.fn(),
          resolveSharedFile: resolveFile,
          resolveLocalWorkspaceFile: resolveFile,
          listLocalWorkspaceDirectory: vi.fn(),
        },
        mailbox: { resolveAttachment: vi.fn() },
        remoteServers: {
          supportsCapability: vi.fn(),
          request: vi.fn(),
          downloadSharedFile: vi.fn(),
          downloadWorkspaceFile: vi.fn(),
          uploadAttachment: vi.fn(),
          downloadAttachment: vi.fn(),
        },
      });
      handlers.agentAttachments[endpoint](endpoint);
      const invoke = bound.get(endpoint);
      if (!invoke) throw new Error("Preview handler was not registered.");
      const sender = { senderFrame: { url: "openbot-app://app/index.html" } };
      const payload = { serverId: "local", payload: { agentId: "preview-agent", path } };
      const oldRequest = invoke(sender, payload);
      await started.promise;
      filePreviewPages.clear();
      resolved.resolve();
      expect(await oldRequest).not.toHaveProperty("pageUrl");
      expect(await invoke(sender, payload)).toHaveProperty("pageUrl");
    },
  );
});
