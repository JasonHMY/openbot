import {
  type AttachmentSummary,
  type BrowserBounds,
  canPreviewAttachment,
  type FileAction,
  type WorkspaceDirectory,
} from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createMemo, createSignal, createStore } from "solid-js";
import { createScopeGuard } from "../../../scope-lifetime";
import { attachmentFilePreview } from "../attachment-preview";
import { releaseFilePreviewPage } from "../conversation-port";
import { conversationRuntime } from "../conversation-runtime";
import type {
  ConversationProps,
  ConversationTarget,
  RightPanelMode,
  SidebarFilePreview,
  SidePanelPane,
} from "../conversation-types";

// Each member reads the interface language when it is called.
const { t, errorMessage } = currentText();

export interface RoutineSettingsRequest {
  agentId: string;
  routineId: string;
  routineName: string;
  nonce: number;
}

/** The panes of one agent's side panel. The panel keeps them while it is closed. */
export interface SidePanelState {
  panes: readonly SidePanelPane[];
  /** The pane on screen, or the last one before the panel closed. */
  selected: SidePanelPane | null;
  maximized: boolean;
}

const SIDE_PANEL_EMPTY: SidePanelState = { panes: [], selected: null, maximized: false };

/** The panel mode of each pane. */
export const SIDE_PANEL_MODES = {
  browser: "browser",
  files: "files",
  tasks: "task",
  settings: "settings",
} as const satisfies Record<SidePanelPane, RightPanelMode>;

function isSidePanelPane(value: string): value is SidePanelPane {
  return value in SIDE_PANEL_MODES;
}

/** The pane that shows a panel mode, or null for a mode outside the side panel. */
function paneOfMode(mode: RightPanelMode): SidePanelPane | null {
  for (const [pane, paneMode] of Object.entries(SIDE_PANEL_MODES)) {
    if (paneMode === mode && isSidePanelPane(pane)) return pane;
  }
  return null;
}

export interface PanelsStoreDeps {
  props: ConversationProps;
  rightPanels: () => Record<string, RightPanelMode>;
  setRightPanels: (update: (current: Record<string, RightPanelMode>) => Record<string, RightPanelMode>) => void;
  settingsProvider: () => import("@openbot/contracts/ipc").AgentProviderId;
  settingsModel: () => import("@openbot/contracts/ipc").AgentModelId;
  settingsReasoning: () => import("@openbot/contracts/ipc").AgentReasoningEffort;
  setBrowserPipBounds: (bounds: BrowserBounds | null) => void;
  sidebarFilePreview: () => SidebarFilePreview | null;
  setSidebarFilePreview: (preview: SidebarFilePreview | null) => void;
  setComposerError: (error: string | null, targetOverride?: ConversationTarget) => void;
  nextFilePreviewGeneration: () => number;
  currentFilePreviewGeneration: () => number;
  invalidateFilePreviewGeneration: () => void;
}

export function createPanelsStore(deps: PanelsStoreDeps) {
  const scopeActive = createScopeGuard();
  const [skillSettingsRequest, setSkillSettingsRequest] = createSignal<{ agentId: string; skillId: string } | null>(
    null,
  );
  function openSkillSettings(skill: { skillId: string }): void {
    const agentId = deps.props.agent?.id;
    if (!agentId || deps.props.server?.id !== "local") return;
    setSkillSettingsRequest({ agentId, skillId: skill.skillId });
    setActiveRightPanel("settings", agentId);
  }
  const [routineSettingsRequest, setRoutineSettingsRequest] = createSignal<RoutineSettingsRequest | null>(null);
  let routineSettingsRequestNonce = 0;

  const activeRightPanel = createMemo<RightPanelMode>(() => {
    const agentId = deps.props.agent?.id;
    return agentId ? (deps.rightPanels()[agentId] ?? "none") : "none";
  });
  /**
   * The side panel of each agent, and the task in its Tasks pane. A task of null is a new task, until its
   * first message starts it; an agent with no task entry shows the task list.
   */
  const [panels, setPanels] = createStore<{
    side: Record<string, SidePanelState>;
    tasks: Record<string, string | null>;
  }>({ side: {}, tasks: {} });
  const sidePanel = (): SidePanelState => {
    const agentId = deps.props.agent?.id;
    return (agentId && panels.side[agentId]) || SIDE_PANEL_EMPTY;
  };
  const sidePanelOpen = () => activeRightPanel() === "side-panel" || paneOfMode(activeRightPanel()) !== null;
  function updateSidePanel(agentId: string, update: (state: SidePanelState) => SidePanelState) {
    setPanels((draft) => {
      draft.side[agentId] = update(draft.side[agentId] ?? SIDE_PANEL_EMPTY);
    });
  }
  function setSidePanelMaximized(maximized: boolean) {
    const agentId = deps.props.agent?.id;
    if (agentId) updateSidePanel(agentId, (state) => ({ ...state, maximized }));
  }
  /** Removes the tab of a pane. Returns the pane to show in its place, or null when no tab stays. */
  function removeSidePanelPane(pane: SidePanelPane): SidePanelPane | null {
    const agentId = deps.props.agent?.id;
    if (!agentId) return null;
    const state = panels.side[agentId] ?? SIDE_PANEL_EMPTY;
    const index = state.panes.indexOf(pane);
    const panes = state.panes.filter((item) => item !== pane);
    const selected =
      state.selected === pane ? (panes[Math.min(Math.max(index, 0), panes.length - 1)] ?? null) : state.selected;
    updateSidePanel(agentId, () => ({ panes, selected, maximized: panes.length > 0 && state.maximized }));
    return selected;
  }
  const settingsOpen = () => activeRightPanel() === "settings";
  const filesOpen = () => activeRightPanel() === "files";
  const taskPanelOpen = () => activeRightPanel() === "task" && deps.props.tasks !== undefined;
  const taskPanelTaskId = (): string | null => {
    const agentId = deps.props.agent?.id;
    return agentId ? (panels.tasks[agentId] ?? null) : null;
  };
  /** The Tasks pane lists the tasks until the user opens one or starts a new one. */
  const taskListOpen = () => {
    const agentId = deps.props.agent?.id;
    return taskPanelOpen() && agentId !== undefined && !(agentId in panels.tasks);
  };
  const filePreviewOpen = () =>
    activeRightPanel() === "file-preview" && deps.sidebarFilePreview()?.ownerAgentId === deps.props.agent?.id;

  function setActiveRightPanel(mode: RightPanelMode, agentId = deps.props.agent?.id) {
    if (!agentId) return;
    if (mode !== "settings") {
      setSkillSettingsRequest(null);
      setRoutineSettingsRequest((current) => (current?.agentId === agentId ? null : current));
    }
    deps.setRightPanels((current) => (current[agentId] === mode ? current : { ...current, [agentId]: mode }));
    const pane = paneOfMode(mode);
    if (pane)
      updateSidePanel(agentId, (state) => ({
        ...state,
        panes: state.panes.includes(pane) ? state.panes : [...state.panes, pane],
        selected: pane,
      }));
    else if (mode === "side-panel") updateSidePanel(agentId, (state) => ({ ...state, selected: null }));
    else if (mode === "none" && panels.side[agentId]?.maximized) {
      updateSidePanel(agentId, (state) => ({ ...state, maximized: false }));
    }
  }

  /** Opens a task in the side panel, or a new task when `taskId` is null. */
  function openTaskPanel(taskId: string | null): void {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    setPanels((draft) => {
      draft.tasks[agentId] = taskId;
    });
    if (taskId) deps.props.tasks?.onOpen(taskId);
    setActiveRightPanel("task", agentId);
  }

  /** The Tasks pane, at its list. */
  function showTaskList(): void {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    setPanels((draft) => {
      delete draft.tasks[agentId];
    });
    setActiveRightPanel("task", agentId);
  }

  function openRoutineSettings(routine: { routineId: string; name: string }): void {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    routineSettingsRequestNonce += 1;
    setRoutineSettingsRequest({
      agentId,
      routineId: routine.routineId,
      routineName: routine.name,
      nonce: routineSettingsRequestNonce,
    });
    setActiveRightPanel("settings", agentId);
  }

  function handleRoutineSettingsRequest(nonce: number): void {
    setRoutineSettingsRequest((current) => (current?.nonce === nonce ? null : current));
  }

  function clearRoutineSettingsRequest(): void {
    setRoutineSettingsRequest(null);
  }

  function openRoutineRunMessage(messageId: string): void {
    setActiveRightPanel("none");
    void deps.props.onOpenSearchMessage?.(messageId);
  }

  function showBrowserPip() {
    setActiveRightPanel("browser-pip");
  }

  function saveBrowserPipBounds(bounds: BrowserBounds) {
    deps.setBrowserPipBounds(bounds);
    window.localStorage.setItem(
      "openbot:browser-pip-native-bounds",
      [bounds.x, bounds.y, bounds.width, bounds.height].join(","),
    );
  }

  function hideBrowserPanel() {
    setActiveRightPanel("none");
    if (deps.props.browserEnabled !== false)
      void conversationRuntime(deps.props).browser.setVisible({ visible: false });
  }

  /**
   * Opens an attachment in the file preview panel, the same surface a shared or workspace file
   * uses. The bytes come from `previewUrl` rather than the preview IPC, because an attachment is
   * named by its id and has no path on the agent's computer.
   */
  async function previewAttachment(attachment: AttachmentSummary) {
    const ownerAgentId = deps.props.agent?.id;
    if (!ownerAgentId || !canPreviewAttachment(attachment)) return;
    const target = { agentId: ownerAgentId, serverId: deps.props.server?.id ?? "local" };
    const generation = deps.nextFilePreviewGeneration();
    deps.setComposerError(null, target);
    try {
      const preview = await (deps.props.runtime?.previewAttachment?.(attachment) ?? attachmentFilePreview(attachment));
      if (generation !== deps.currentFilePreviewGeneration() || deps.props.agent?.id !== ownerAgentId) return;
      deps.setSidebarFilePreview({ ownerAgentId, source: { kind: "attachment", attachment }, preview });
      setActiveRightPanel("file-preview", ownerAgentId);
    } catch (error) {
      if (generation !== deps.currentFilePreviewGeneration()) return;
      deps.setComposerError(errorMessage(error, t("attachment.error.preview", { name: attachment.name })), target);
    }
  }

  function attachmentAction(attachment: AttachmentSummary, action: FileAction) {
    // A runtime has no app to open a file in, so a file it can preview opens in the panel.
    if (action === "open" && deps.props.runtime && canPreviewAttachment(attachment)) {
      void previewAttachment(attachment);
      return;
    }
    const agentId = deps.props.agent?.id;
    const target = agentId ? { agentId, serverId: deps.props.server?.id ?? "local" } : undefined;
    void conversationRuntime(deps.props)
      .agent.openAttachment({ attachmentId: attachment.id, action })
      .catch((error) => deps.setComposerError(errorMessage(error, t("attachment.error.open")), target));
  }

  function openSharedFile(path: string) {
    const ownerAgentId = deps.props.agent?.id;
    if (!ownerAgentId) return;
    const serverId = deps.props.server?.id ?? "local";
    const target = { agentId: ownerAgentId, serverId };
    const generation = deps.nextFilePreviewGeneration();
    deps.setComposerError(null, target);
    void conversationRuntime(deps.props)
      .agent.previewSharedFile({ path })
      .then(
        (preview) => {
          if (
            !scopeActive() ||
            generation !== deps.currentFilePreviewGeneration() ||
            deps.props.agent?.id !== ownerAgentId
          ) {
            releaseFilePreviewPage(preview.pageUrl);
            return;
          }
          deps.setSidebarFilePreview({ ownerAgentId, source: { kind: "shared", path }, preview });
          setActiveRightPanel("file-preview", ownerAgentId);
        },
        (error) => {
          if (!scopeActive() || generation !== deps.currentFilePreviewGeneration()) return;
          deps.setComposerError(filePreviewError(error, path), target);
        },
      );
  }

  /**
   * A chip can name a folder as well as a file. When the file preview fails, the folder listing is
   * tried; when that fails too, the preview error stays, because it names the path the agent wrote.
   */
  function openWorkspaceFile(path: string, folder?: string) {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    const serverId = deps.props.server?.id ?? "local";
    const target = { agentId, serverId };
    const generation = deps.nextFilePreviewGeneration();
    const current = () =>
      scopeActive() && generation === deps.currentFilePreviewGeneration() && deps.props.agent?.id === agentId;
    const agent = conversationRuntime(deps.props).agent;
    deps.setComposerError(null, target);
    void agent.previewWorkspaceFile({ agentId, path }).then(
      (preview) => {
        if (!current()) {
          releaseFilePreviewPage(preview.pageUrl);
          return;
        }
        deps.setSidebarFilePreview({ ownerAgentId: agentId, source: { kind: "workspace", path, folder }, preview });
        setActiveRightPanel("file-preview", agentId);
      },
      (error) =>
        agent.listWorkspaceDirectory({ agentId, path }).then(
          (directory) => {
            if (!current()) return;
            showWorkspaceFolder(agentId, path, directory);
          },
          () => {
            if (!scopeActive() || generation !== deps.currentFilePreviewGeneration()) return;
            deps.setComposerError(filePreviewError(error, path), target);
          },
        ),
    );
  }

  function openWorkspaceFolder(path: string) {
    const agentId = deps.props.agent?.id;
    if (!agentId) return;
    const target = { agentId, serverId: deps.props.server?.id ?? "local" };
    const generation = deps.nextFilePreviewGeneration();
    deps.setComposerError(null, target);
    void conversationRuntime(deps.props)
      .agent.listWorkspaceDirectory({ agentId, path })
      .then(
        (directory) => {
          if (generation !== deps.currentFilePreviewGeneration() || deps.props.agent?.id !== agentId) return;
          showWorkspaceFolder(agentId, path, directory);
        },
        (error) => {
          if (generation !== deps.currentFilePreviewGeneration()) return;
          deps.setComposerError(filePreviewError(error, path), target);
        },
      );
  }

  function showWorkspaceFolder(agentId: string, path: string, directory: WorkspaceDirectory) {
    deps.setSidebarFilePreview({
      ownerAgentId: agentId,
      source: { kind: "workspace-folder", path },
      preview: null,
      directory,
    });
    setActiveRightPanel("file-preview", agentId);
  }

  /** Opens a file of the folder view, so that the panel can go back to the folder. */
  function openWorkspaceFolderEntry(path: string) {
    const file = deps.sidebarFilePreview();
    openWorkspaceFile(path, file?.directory?.path);
  }

  /** Back to the folder a file came from, or up one folder. Absent when there is nowhere to go. */
  function sidebarFileBack(): string | null {
    const file = deps.sidebarFilePreview();
    if (file?.directory) return file.directory.parentPath;
    return file?.source.kind === "workspace" ? (file.source.folder ?? null) : null;
  }

  function openSidebarFileBack() {
    const path = sidebarFileBack();
    if (path !== null) openWorkspaceFolder(path);
  }

  function openSidebarFileExternally() {
    sidebarFileAction("open");
  }

  function downloadSidebarFile() {
    sidebarFileAction("download");
  }

  function revealSidebarFile() {
    sidebarFileAction("reveal");
  }

  function sidebarFileAction(action: FileAction) {
    const file = deps.sidebarFilePreview();
    if (!file) return;
    const source = file.source;
    if (source.kind === "attachment") {
      attachmentAction(source.attachment, action);
      return;
    }
    if (source.kind === "workspace-folder") return;
    const target = { agentId: file.ownerAgentId, serverId: deps.props.server?.id ?? "local" };
    const agent = conversationRuntime(deps.props).agent;
    const request =
      source.kind === "shared"
        ? agent.openSharedFile({ path: source.path, action })
        : agent.openWorkspaceFile({ agentId: file.ownerAgentId, path: source.path, action });
    const fallback = action === "download" ? t("attachment.error.download") : t("attachment.error.openFile");
    void request.catch((error) => deps.setComposerError(errorMessage(error, fallback), target));
  }

  function closeSidebarFilePreview() {
    deps.invalidateFilePreviewGeneration();
    deps.setSidebarFilePreview(null);
    setActiveRightPanel("none");
  }

  return {
    skillSettingsRequest,
    openSkillSettings,
    routineSettingsRequest,
    activeRightPanel,
    settingsOpen,
    filesOpen,
    taskPanelOpen,
    taskPanelTaskId,
    taskListOpen,
    openTaskPanel,
    showTaskList,
    sidePanel,
    sidePanelOpen,
    setSidePanelMaximized,
    removeSidePanelPane,
    filePreviewOpen,
    setActiveRightPanel,
    openRoutineSettings,
    handleRoutineSettingsRequest,
    clearRoutineSettingsRequest,
    openRoutineRunMessage,
    showBrowserPip,
    saveBrowserPipBounds,
    hideBrowserPanel,
    previewAttachment,
    attachmentAction,
    openSharedFile,
    openWorkspaceFile,
    openWorkspaceFolder,
    openWorkspaceFolderEntry,
    sidebarFileBack,
    openSidebarFileBack,
    openSidebarFileExternally,
    downloadSidebarFile,
    revealSidebarFile,
    closeSidebarFilePreview,
  };
}

function filePreviewError(error: unknown, path: string): string {
  let decodedPath = path;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    // A literal percent sign can be part of a file name.
  }
  const name = decodedPath.replaceAll("\\", "/").split("/").pop() || t("attachment.error.fileFallback");
  if (error instanceof Error && /\bENOENT\b/u.test(error.message)) {
    return t("attachment.error.fileNotFound", { name });
  }
  return errorMessage(error, t("attachment.error.previewFile", { name }));
}
