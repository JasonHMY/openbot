import type { ServerSummary } from "@openbot/contracts/ipc";
import { classifyFailure } from "@openbot/telemetry";
import { SETTINGS_PANEL_DEFAULT, SETTINGS_PANEL_MAX } from "@openbot/ui/components/SettingsPanel";
import type { AgentMessage } from "@openbot/ui/data";
import { AgentTaskList, AgentTaskPanel } from "@openbot/ui/features/conversation/AgentTasks";
import { SidePanelHeader, SidePanelLauncher, type SidePanelPane } from "@openbot/ui/features/conversation/SidePanel";
import { McpSignInRelayDialog } from "@openbot/ui/features/settings/McpSignInPage";
import { useText } from "@openbot/ui/text";
import { actionToast } from "../../action-toast";
import { toAgentMessages } from "../../app-message-projection";
import { agentTemplatesPort } from "../agent-templates/agent-templates-port";
import { createPublishAgent } from "../agent-templates/PublishAgent";
import { serverCanAdministerAgents } from "../agents/remote-agent-admin";
import type { AgentFilesOptions } from "../files/AgentFilesSettings";
import { canManageStorage, serverHasStorage } from "../files/storage-usage";
import { remoteRoutineRecovery, serverCanAdminister, serverSupportsCapability } from "../servers/server-capabilities";
import { htmlAttachmentPageHtml, htmlAttachmentPageUrl } from "./chat-visual-url";
import { useConversationController } from "./conversation-controller-context";
import { useConversationViewScope } from "./conversation-scope";
import { desktopEventRoutinesApi } from "./routine-webhooks-api";

const BROWSER_PANEL_DEFAULT_RATIO = 0.5;
const BROWSER_PANEL_MIN = 220;
const BROWSER_PANEL_MAX = 1600;
const CONVERSATION_PANEL_MIN = 96;
const loadAgentSettingsPanel = () => import("./AgentSettingsPanel");

import { Portal } from "@solidjs/web";
import { createEffect, createMemo, createProjection, Loading, lazy, onSettled, Show } from "solid-js";
import { conversationPort } from "./conversation-port";

/** @internal Stable HMR boundary for conversation panels. */
export function ConversationPanels(panelProps: { onOpenUsage?: (trigger: HTMLButtonElement) => void }) {
  const controller = useConversationController();
  const {
    agentReady,
    activateBrowserTab,
    activeBrowserControl,
    activeBrowserTab,
    agentActivity,
    browserAddress,
    browserControlForTab,
    browserControllerForTab,
    browserSidebarOpen,
    browserExpandedOpen,
    hideBrowserPanel,
    browserTabs,
    closeSidebarFilePreview,
    closeBrowserTab,
    downloadSidebarFile,
    revealSidebarFile,
    conversationPanelElement,
    filePreviewOpen,
    filesOpen,
    openBrowserAddress,
    openExternalMessageUrl,
    openRoutineRunMessage,
    openSharedFile,
    previewAttachment,
    openSidebarFileExternally,
    openWorkspaceFile,
    openWorkspaceFolder,
    openWorkspaceFolderEntry,
    sidebarFileBack,
    openSidebarFileBack,
    navigateBrowserTab,
    props,
    reloadBrowserTab,
    setActiveRightPanel,
    setBrowserAddress,
    setBrowserAddressEditing,
    setBrowserPanelWidth,
    setBrowserSurfaceElement,
    setSettingsPanelWidth,
    showBrowserPip,
    handleRoutineSettingsRequest,
    sidebarFilePreview,
    settingsOpen,
    skillSettingsRequest,
    routineSettingsRequest,
    settingsModel,
    settingsProvider,
    settingsReasoning,
    updateRuntimeSettings,
    messageLinkRelay,
    openMessageLinkRelay,
    pasteMessageLinkRelay,
    cancelMessageLinkRelay,
    attachmentAction,
    taskPanelOpen,
    taskPanelTaskId,
    taskListOpen,
    openTaskPanel,
    showTaskList,
    activeRightPanel,
    sidePanel,
    sidePanelOpen,
    setSidePanelMaximized,
    openSidePanelPane,
    toggleSidePanel,
    closeSidePanelPane,
  } = useConversationViewScope();
  const { t, errorMessage } = useText();
  const publishAgent = createPublishAgent(
    () => props.runtime?.admin?.agentTemplates ?? agentTemplatesPort().agentTemplates,
  );
  // This computer reads the skills of its own agents from the workspace. A joined host publishes its
  // own agents, for an owner or admin, when it serves `agent-publish-v1`.
  const canPublish = () =>
    props.runtime
      ? props.runtime.admin !== undefined && serverCanAdminister(props.server, "agent-publish-v1")
      : props.server?.kind === "local";
  let browserPreviewTrigger: HTMLButtonElement | undefined;
  /** The panes this chat can open. The web client has no Files pane, and a chat without a thread has no files. */
  const sidePanelPanes = createMemo((): SidePanelPane[] => [
    ...(props.browserEnabled !== false ? (["browser"] as const) : []),
    ...(!props.runtime && props.agent?.threadId && serverHasStorage(props.server) ? (["files"] as const) : []),
    ...(props.tasks ? (["tasks"] as const) : []),
    ...(props.agent ? (["settings"] as const) : []),
  ]);
  const panelTask = createMemo(() => {
    const taskId = taskPanelTaskId();
    return taskId ? (props.tasks?.snapshot?.tasks.find((task) => task.id === taskId) ?? null) : null;
  });
  /** Reconciled by id, so a stream chunk redraws only the message that changed. */
  const panelTaskMessages = createProjection<AgentMessage[]>(
    () => {
      const taskId = taskPanelTaskId();
      const conversation = taskId ? props.tasks?.conversation(taskId) : undefined;
      return conversation ? toAgentMessages(conversation.messages, props.agent?.id) : [];
    },
    [],
    { key: "id" },
  );
  /** A message in a task steers or continues it. In a new task, the first message starts it. */
  async function sendToTaskPanel(text: string): Promise<boolean> {
    const tasks = props.tasks;
    if (!tasks) return false;
    const task = panelTask();
    if (task) return tasks.onSend(task.id, text);
    const created = await tasks.onStart(text);
    if (!created) return false;
    if (taskPanelOpen() && taskPanelTaskId() === null) openTaskPanel(created.id);
    return true;
  }
  const settingsMaxWidth = () =>
    Math.min(
      SETTINGS_PANEL_MAX,
      Math.max(
        SETTINGS_PANEL_DEFAULT,
        (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
      ),
    );
  /** Agent settings > Files. */
  const agentFiles = (server: ServerSummary | undefined, agentId: string): AgentFilesOptions | undefined => {
    // The web client shows host files in Server settings > Storage; its agent settings have no Files.
    if (props.runtime || !serverHasStorage(server)) return undefined;
    return {
      serverId: server.id,
      canManage: canManageStorage(server),
      onOpenWorkspace:
        server.kind === "local"
          ? () =>
              void conversationPort()
                .storage.openLocation({ agentId })
                .catch((error) =>
                  actionToast.error(t("conversation.panels.openWorkspaceFailed"), {
                    ...{
                      description: errorMessage(error, t("conversation.panels.tryAgain")),
                    },
                    report: { operation: "turn", source: "action", cause_code: classifyFailure(error) },
                  }),
                )
          : undefined,
      onPreviewFile: (file) => void previewAttachment(file),
      onShowMessage: (messageId) => openRoutineRunMessage(messageId),
      // The agent's chat is behind the settings, so closing them opens it.
      onOpenConversation: () => setActiveRightPanel("none"),
    };
  };
  createEffect(
    () => ({ expanded: browserExpandedOpen(), suspended: props.globalOverlayOpen || props.remoteDesktopVisible }),
    ({ expanded, suspended }) => {
      if (!expanded || suspended) return;
      const frame = conversationPanelElement()?.closest<HTMLElement>(".app-frame");
      if (!frame) return;
      const wasInert = frame.inert;
      frame.inert = true;
      return () => {
        frame.inert = wasInert;
      };
    },
  );
  createEffect(browserSidebarOpen, (open, previous) => {
    if (open && previous === false) onSettled(() => browserPreviewTrigger?.focus());
  });
  return (
    <>
      <Show when={sidePanelOpen()}>
        <SidePanelHeader
          panes={sidePanel().panes}
          selected={activeRightPanel() === "side-panel" ? null : sidePanel().selected}
          available={sidePanelPanes()}
          maximized={sidePanel().maximized}
          onSelect={openSidePanelPane}
          onClose={closeSidePanelPane}
          onToggleMaximized={() => setSidePanelMaximized(!sidePanel().maximized)}
          onCollapse={toggleSidePanel}
        />
      </Show>

      <Show when={activeRightPanel() === "side-panel"}>
        <aside class="browser-panel side-panel-empty" aria-label={t("conversation.sidePanel.label")}>
          <SidePanelLauncher available={sidePanelPanes()} onOpen={openSidePanelPane} />
        </aside>
      </Show>

      <Show when={filePreviewOpen() && sidebarFilePreview()}>
        {(file) => {
          const attached = () => {
            const source = file().source;
            return source.kind === "attachment" ? source.attachment : null;
          };
          return (
            <Loading>
              <FilePreviewPanel
                allowExternalOpen={!props.runtime}
                preview={file().preview}
                directory={file().directory ?? null}
                agents={props.agents}
                defaultWidth={() =>
                  (conversationPanelElement()?.clientWidth || window.innerWidth) * BROWSER_PANEL_DEFAULT_RATIO
                }
                maxWidth={() =>
                  Math.min(
                    BROWSER_PANEL_MAX,
                    Math.max(
                      BROWSER_PANEL_MIN,
                      (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
                    ),
                  )
                }
                onWidthChange={setBrowserPanelWidth}
                onOpenLink={(url) => void openExternalMessageUrl(url)}
                onOpenSharedFile={openSharedFile}
                onOpenWorkspaceFile={file().directory ? openWorkspaceFolderEntry : openWorkspaceFile}
                onOpenWorkspaceFolder={openWorkspaceFolder}
                onBack={sidebarFileBack() === null ? undefined : openSidebarFileBack}
                sourceUrl={attached()?.previewUrl ?? null}
                pageUrl={htmlAttachmentPageUrl(attached()) ?? file().preview?.pageUrl}
                pageHtml={props.runtime?.visualPage ? htmlAttachmentPageHtml(attached(), file().preview) : undefined}
                onOpenExternally={openSidebarFileExternally}
                onDownload={downloadSidebarFile}
                /* A browser cannot show a file in the file manager. */
                onReveal={props.runtime ? undefined : revealSidebarFile}
                onClose={closeSidebarFilePreview}
              />
            </Loading>
          );
        }}
      </Show>

      <Show when={filesOpen() && !props.runtime && serverHasStorage(props.server) && props.server}>
        {(server) => (
          <Show when={props.agent?.threadId}>
            {(threadId) => (
              <Loading>
                <ChatFilesPanel
                  serverId={server().id}
                  conversationId={threadId()}
                  conversationTitle={props.agent?.name ?? "this chat"}
                  canManage={canManageStorage(server())}
                  onClose={() => closeSidePanelPane("files")}
                  onPreviewFile={(file) => void previewAttachment(file)}
                  onShowMessage={(messageId) => void props.onOpenSearchMessage?.(messageId)}
                />
              </Loading>
            )}
          </Show>
        )}
      </Show>

      <Show when={taskListOpen() && props.tasks}>
        {(tasks) => (
          <AgentTaskList
            tasks={tasks().snapshot?.tasks ?? []}
            onNew={() => openTaskPanel(null)}
            onOpen={openTaskPanel}
            onClosePanel={() => closeSidePanelPane("tasks")}
          />
        )}
      </Show>

      <Show when={taskPanelOpen() && !taskListOpen() && props.tasks && props.agent}>
        {(agent) => (
          <AgentTaskPanel
            task={panelTask()}
            limit={props.tasks?.snapshot?.limit ?? 1}
            agent={agent()}
            agents={props.agents}
            messages={panelTaskMessages}
            onSend={sendToTaskPanel}
            onStop={() => {
              const task = panelTask();
              if (task) props.tasks?.onStop(task.id);
            }}
            onCloseTask={() => {
              const task = panelTask();
              if (task) props.tasks?.onClose(task.id);
            }}
            onReopen={() => {
              const task = panelTask();
              if (task) props.tasks?.onReopen(task.id);
            }}
            onClosePanel={() => closeSidePanelPane("tasks")}
            onBack={showTaskList}
            onOpenLink={(url) => void openExternalMessageUrl(url)}
            onPreview={(attachment) => void previewAttachment(attachment)}
            onAttachmentAction={attachmentAction}
          />
        )}
      </Show>

      <Show when={browserSidebarOpen() || browserExpandedOpen()}>
        <BrowserPreviewSidebar
          tabs={browserTabs()}
          hidden={browserExpandedOpen()}
          suspended={props.browserVisibilitySuspended || props.globalOverlayOpen || props.remoteDesktopVisible}
          contextKey={`${props.server?.id ?? "local"}:${props.agent?.id ?? ""}`}
          defaultWidth={() => 320}
          maxWidth={() =>
            Math.min(
              BROWSER_PANEL_MAX,
              Math.max(
                BROWSER_PANEL_MIN,
                (conversationPanelElement()?.clientWidth || window.innerWidth) - CONVERSATION_PANEL_MIN,
              ),
            )
          }
          onWidthChange={setBrowserPanelWidth}
          capturePreview={props.runtime?.browser.capturePreview}
          onOpenTab={(tabId, trigger) => {
            browserPreviewTrigger = trigger;
            if (activeBrowserTab()?.id !== tabId) activateBrowserTab(tabId);
            setActiveRightPanel("browser-expanded");
          }}
          onCloseTab={(tabId) => void closeBrowserTab(tabId)}
          onNewTab={() => void openBrowserAddress("https://www.google.com", true)}
          onCollapse={hideBrowserPanel}
        />
      </Show>

      <Show when={browserSidebarOpen() || browserExpandedOpen()}>
        <Portal>
          <div class="ui-dialog-overlay browser-expanded-backdrop" hidden={!browserExpandedOpen()} aria-hidden="true" />
          <BrowserPanel
            open={browserExpandedOpen()}
            macWindowControls={props.platform === "darwin"}
            tabs={browserTabs()}
            activeTab={activeBrowserTab()}
            activeControl={activeBrowserControl()}
            address={browserAddress()}
            controlForTab={browserControlForTab}
            controllerForTab={browserControllerForTab}
            onAddressChange={setBrowserAddress}
            onAddressEditingChange={setBrowserAddressEditing}
            onOpenAddress={(address) => void openBrowserAddress(address, address !== undefined)}
            onNavigate={(tabId, direction) => void navigateBrowserTab(tabId, direction)}
            onReload={(tabId) => void reloadBrowserTab(tabId)}
            onActivateTab={activateBrowserTab}
            onCloseTab={(tabId) => void closeBrowserTab(tabId)}
            canEnterPip={!props.runtime}
            onSurface={setBrowserSurfaceElement}
            liveViewTabId={
              props.server?.kind === "remote" && serverSupportsCapability(props.server, "browser-view")
                ? (activeBrowserTab()?.id ?? null)
                : null
            }
            liveViewRuntime={props.browserRuntime ?? conversationPort().browser}
            liveViewClipboard={serverSupportsCapability(props.server, "browser-view-clipboard")}
            onBack={() => setActiveRightPanel("browser")}
            onEnterPip={props.runtime ? () => undefined : showBrowserPip}
          />
        </Portal>
      </Show>

      <Show when={settingsOpen() && props.agent}>
        {(agent) => (
          <Loading>
            <AgentSettingsPanel
              remoteClient={Boolean(props.runtime)}
              localHost={props.server?.kind === "local"}
              sessionSettingsEditable={serverCanAdminister(props.server, "agent-session-settings-v1")}
              adminCalls={props.runtime?.admin}
              skillsMarketplaceOpen={props.skillsMarketplaceOpen}
              workspaceCovered={props.workspaceCovered}
              onAddFromMarketplace={
                serverCanAdminister(props.server, "skills-admin-v1") ? props.onOpenMarketplace : undefined
              }
              skillsMode={
                props.runtime
                  ? props.runtime.admin && serverCanAdminister(props.server, "skills-admin-v1")
                    ? "host"
                    : "hidden"
                  : props.server?.kind === "local"
                    ? "mutable"
                    : serverCanAdminister(props.server, "skills-admin-v1")
                      ? "host"
                      : "readonly"
              }
              skillsServerId={props.server?.id}
              tablesVisible={
                (!props.runtime || props.runtime.admin !== undefined) &&
                serverCanAdminister(props.server, "shared-tables-v1")
              }
              accessEditable={props.server?.kind === "local" || serverCanAdministerAgents(props.server)}
              computerUseEditable={props.server?.kind === "local"}
              automationEditable={
                props.server?.kind === "local" ||
                (serverCanAdminister(props.server, "agent-host-settings-v1") && agent().allowAutomation !== undefined)
              }
              busyMessageModeEditable={props.server?.kind === "local"}
              taskLimitEditable={props.server?.kind === "local"}
              backupModelsEditable={props.server?.kind === "local"}
              usageLimited={props.usageLimited}
              defaultBusyMessageMode={props.defaultBusyMessageMode}
              memoryLimit={props.server?.kind === "local" ? props.agentMemoryLimit : undefined}
              agents={props.agents}
              onStartNewChat={props.onClearAgentContext}
              onCreateSkill={
                serverCanAdminister(props.server, "skills-admin-v1") &&
                agentReady() &&
                !controller.submitting() &&
                controller.voicePhase() === "idle" &&
                !controller.editingDeliveryId()
                  ? () => {
                      if (!props.agent || !props.server) return;
                      controller.startSkillCreation({ serverId: props.server.id, agentId: props.agent.id });
                      setActiveRightPanel("none");
                    }
                  : undefined
              }
              onTrySkill={
                serverCanAdminister(props.server, "skills-admin-v1") &&
                agentReady() &&
                !controller.submitting() &&
                controller.voicePhase() === "idle" &&
                !controller.editingDeliveryId()
                  ? (skill) => {
                      if (!props.agent || !props.server) return;
                      controller.appendSkillExample({ serverId: props.server.id, agentId: props.agent.id }, skill);
                      setActiveRightPanel("none");
                    }
                  : undefined
              }
              onOpenUsage={panelProps.onOpenUsage}
              onPublish={canPublish() ? () => publishAgent.open(agent().id) : undefined}
              agent={agent()}
              runtimeSettings={{
                provider: settingsProvider(),
                model: settingsModel(),
                reasoningEffort: settingsReasoning(),
              }}
              agentStatus={props.agentStatus}
              providerRuntimeStatuses={props.providerRuntimeStatuses}
              customProviders={props.customProviders}
              customAgents={props.customAgents}
              onDownloadProvider={props.onDownloadProvider}
              onCancelProviderDownload={props.onCancelProviderDownload}
              onConnectProvider={props.onConnectProvider}
              canConnectProvider={props.canConnectProvider}
              onManageProviders={props.onManageProviders}
              modelOptions={props.modelOptions}
              working={agentActivity() === "Working"}
              maxWidth={settingsMaxWidth}
              onClose={() => closeSidePanelPane("settings")}
              onWidthChange={setSettingsPanelWidth}
              onUpdateAgent={props.onUpdateAgent}
              onUpdateRuntimeSettings={updateRuntimeSettings}
              onSetAgentAvatar={props.onSetAgentAvatar}
              skillSelectionRequest={skillSettingsRequest()?.agentId === agent().id ? skillSettingsRequest() : null}
              routineSelectionRequest={
                routineSettingsRequest()?.agentId === agent().id ? routineSettingsRequest() : null
              }
              onRoutineSelectionRequestHandled={handleRoutineSettingsRequest}
              onOpenRoutineRun={props.onOpenSearchMessage ? openRoutineRunMessage : undefined}
              files={agentFiles(props.server, agent().id)}
              eventRoutines={
                !props.runtime && serverCanAdminister(props.server, "events-v1")
                  ? desktopEventRoutinesApi(props.server.id, remoteRoutineRecovery(props.server))
                  : undefined
              }
            />
          </Loading>
        )}
      </Show>

      {publishAgent.dialog()}
      {/* A sign-in link of the host's agent, when this computer cannot take its callback: the user pastes
          the address that the browser shows. */}
      <Show when={messageLinkRelay()} keyed>
        {(relay) => (
          <McpSignInRelayDialog
            name={relay.page.authorizeHost}
            hostName={props.server?.name ?? ""}
            page={relay.page}
            onOpen={openMessageLinkRelay}
            onPaste={pasteMessageLinkRelay}
            onCancel={cancelMessageLinkRelay}
          />
        )}
      </Show>
    </>
  );
}

const AgentSettingsPanel = lazy(loadAgentSettingsPanel);
const BrowserPanel = lazy(() => import("@openbot/ui/features/browser/BrowserPanel"));
const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));
const ChatFilesPanel = lazy(() => import("../files/ChatFilesPanel"));

const BrowserPreviewSidebar = lazy(() => import("./BrowserPreviewSidebar"));
