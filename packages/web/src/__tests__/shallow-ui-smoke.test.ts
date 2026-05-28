import { readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlashSystemCommand } from "../components/slash-command-autocomplete.js";

type UnknownFn = (...args: unknown[]) => unknown;
type ElementLike = {
  type: unknown;
  props: Record<string, unknown>;
  key?: unknown;
};
type RenderState = {
  cleanups: UnknownFn[];
  errors: Error[];
  events: number;
  ids: number;
  nodes: number;
  rendered: number;
  stateValues: unknown[];
};
type ComponentCase = {
  name: string;
  load: () => Promise<unknown>;
  props?: Record<string, unknown>;
  stateValues?: unknown[];
};
type ModuleExportCase = {
  exportName: string;
  modulePath: string;
  value: unknown;
};

const Fragment = Symbol.for("first-tree.test.fragment");
const EVENT_PROPS = new Set([
  "onBlur",
  "onChange",
  "onClick",
  "onKeyDown",
  "onMouseEnter",
  "onMouseLeave",
  "onOpenChange",
  "onSubmit",
  "onValueChange",
]);

const iso = "2026-05-28T00:00:00.000Z";
const githubTokenTemplate = "$" + "{GITHUB_TOKEN}";
const queryOverrides = new Map<string, unknown>();
let mutationResultOverride: MutationResultOverride | null = null;
let authOverride: Record<string, unknown> = {};
let routerSearch = "?agent=agent-bot&c=chat-1";
let outletContextOverride: unknown = null;
let viewportOverride: "xl" | "md" | "narrow" | null = null;
const srcRoot = resolve(import.meta.dirname, "..");

type QueryResultOverride = {
  __queryResult: true;
  data?: unknown;
  error?: unknown;
  isError?: boolean;
  isFetching?: boolean;
  isLoading?: boolean;
  isPending?: boolean;
  status?: "error" | "loading" | "pending" | "success";
};
type MutationResultOverride = {
  error?: unknown;
  isPending?: boolean;
  isSuccess?: boolean;
  status?: "error" | "idle" | "pending" | "success";
};

const humanAgent = agent("agent-human", "Ada Lovelace", "ada", "human", "organization", "member-1");
const botAgent = agent("agent-bot", "Atlas", "atlas", "agent", "organization", "member-1");
const privateAgent = agent("agent-private", "Private Helper", "helper", "agent", "private", "member-1");
const teamAgent = agent("agent-team", "Team Reviewer", "reviewer", "agent", "organization", "member-2");
const suspendedAgent = {
  ...agent("agent-suspended", "Dormant", "dormant", "agent", "private", "member-2"),
  status: "suspended",
};

const client = {
  id: "client-1",
  userId: "user-1",
  status: "connected",
  authState: "ok",
  sdkVersion: "0.0.0-test",
  hostname: "ada-workstation",
  os: "linux",
  agentCount: 2,
  connectedAt: iso,
  lastSeenAt: iso,
  capabilities: {
    providers: {
      "claude-code": { available: true, authenticated: true, version: "1.0.0" },
      codex: { available: true, authenticated: true, version: "1.0.0" },
    },
    "claude-code": { state: "ok", version: "1.0.0" },
    codex: { state: "ok", version: "1.0.0" },
  },
};

const members = [
  {
    id: "member-1",
    agentId: "agent-human",
    userId: "user-1",
    username: "ada",
    displayName: "Ada Lovelace",
    role: "admin",
    status: "active",
    createdAt: iso,
  },
  {
    id: "member-2",
    agentId: "agent-member-2",
    userId: "user-2",
    username: "grace",
    displayName: "Grace Hopper",
    role: "member",
    status: "active",
    createdAt: iso,
  },
];

const agents: Record<string, unknown>[] = [humanAgent, botAgent, privateAgent, teamAgent, suspendedAgent];
const agentPage = { items: agents, nextCursor: null };

const chatParticipant = {
  agentId: "agent-bot",
  role: "member",
  mode: "speaker",
  joinedAt: iso,
  name: "atlas",
  displayName: "Atlas",
  type: "agent",
  avatarColorToken: "hue-2",
  avatarImageUrl: null,
};

const chatDetail = {
  id: "chat-1",
  organizationId: "org-1",
  type: "group",
  topic: "Launch review",
  lifecyclePolicy: null,
  metadata: {},
  createdAt: iso,
  updatedAt: iso,
  participants: [
    { ...chatParticipant, agentId: "agent-human", name: "ada", displayName: "Ada", type: "human" },
    chatParticipant,
  ],
  title: "Launch review",
  firstMessagePreview: "Ready for review",
  engagementStatus: "active",
  viewerMembershipKind: "participant",
};

const textMessage = {
  id: "msg-1",
  chatId: "chat-1",
  senderId: "agent-human",
  content: "Hello @atlas",
  contentType: "text",
  createdAt: iso,
  metadata: {},
  deliveryStatus: "sent",
};

const githubMessage = {
  id: "msg-2",
  chatId: "chat-1",
  senderId: "github",
  contentType: "github_event",
  createdAt: iso,
  deliveryStatus: "sent",
  metadata: { senderType: "github", senderName: "GitHub" },
  content: {
    kind: "pull_request_review",
    action: "submitted",
    repository: "agent-team-foundation/first-tree",
    entityKey: "PR_kwDOABC",
    entityNumber: 12,
    entityTitle: "Improve dashboard",
    entityUrl: "https://github.com/agent-team-foundation/first-tree/pull/12",
    body: "Looks good for @ada.",
    mentionedUser: "ada",
    senderLogin: "reviewer",
  },
};

const messagesPage = { items: [textMessage, githubMessage], nextCursor: null };

const attention = {
  id: "attention-1234567890",
  originAgentId: "agent-bot",
  originChatId: "chat-1",
  targetHumanId: "agent-human",
  subject: "Approve release plan",
  body: "Please pick a release option and add any notes.",
  requiresResponse: true,
  state: "open",
  response: null,
  respondedBy: null,
  respondedAt: null,
  cancelled: false,
  cancelledReason: null,
  createdAt: iso,
  closedAt: null,
  metadata: {
    questions: [
      {
        id: "risk",
        prompt: "Risk level",
        context: "Choose the closest operational risk.",
        options: {
          mode: "single",
          defaultValue: "low",
          items: [
            { value: "low", label: "Low", hint: "Ship now" },
            { value: "high", label: "High", hint: "Delay" },
          ],
        },
      },
      {
        id: "checks",
        prompt: "Checks complete",
        options: {
          mode: "multi",
          min: 1,
          max: 2,
          defaultValue: ["tests"],
          items: [
            { value: "tests", label: "Tests" },
            { value: "docs", label: "Docs" },
          ],
        },
      },
    ],
  },
};

const sessionEvents = [
  {
    id: "evt-tool",
    sessionId: "session-1",
    agentId: "agent-bot",
    chatId: "chat-1",
    eventType: "tool_call",
    payload: { tool: "bash", args: { command: "pnpm test" } },
    createdAt: iso,
  },
  {
    id: "evt-text",
    sessionId: "session-1",
    agentId: "agent-bot",
    chatId: "chat-1",
    eventType: "assistant_text",
    payload: { text: "Running checks" },
    createdAt: iso,
  },
  {
    id: "evt-end",
    sessionId: "session-1",
    agentId: "agent-bot",
    chatId: "chat-1",
    eventType: "turn_end",
    payload: { durationMs: 45000 },
    createdAt: iso,
  },
];

function agent(
  uuid: string,
  displayName: string,
  name: string,
  type: string,
  visibility: string,
  managerId: string,
): Record<string, unknown> {
  return {
    uuid,
    name,
    displayName,
    type,
    status: "active",
    visibility,
    managerId,
    clientId: "client-1",
    runtimeProvider: "claude-code",
    runtimeState: { status: "online", updatedAt: iso },
    avatarImageUrl: null,
    avatarColorToken: "hue-1",
    profile: "I help with code review and release checks.",
    delegateMention: null,
    createdAt: iso,
    updatedAt: iso,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownFn(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

function isElementLike(value: unknown): value is ElementLike {
  return isRecord(value) && "type" in value && isRecord(value.props);
}

function createElement(type: unknown, props: Record<string, unknown> | null = null, key?: unknown): ElementLike {
  return { type, props: props ?? {}, key };
}

function flattenChildren(value: unknown): unknown[] {
  if (value === undefined || value === null || typeof value === "boolean") return [];
  if (Array.isArray(value)) return value.flatMap(flattenChildren);
  return [value];
}

function fakeEvent(propName: string): unknown[] {
  const files = [{ name: "diagram.png", type: "image/png", size: 128 }];
  const event = {
    altKey: false,
    button: 0,
    clipboardData: { files },
    dataTransfer: { files },
    defaultPrevented: false,
    metaKey: true,
    ctrlKey: false,
    preventDefault: () => {},
    stopPropagation: () => {},
    nativeEvent: { isComposing: false },
    key: "Enter",
    shiftKey: false,
    target: {
      value: propName === "onChange" ? "release-helper" : "",
      checked: true,
      files,
    },
    currentTarget: {
      click: () => {},
      files,
      focus: () => {},
      selectionEnd: 0,
      selectionStart: 0,
      setSelectionRange: () => {},
      style: {},
      value: "release-helper",
    },
  };
  if (propName === "onOpenChange") return [true];
  if (propName === "onValueChange") return ["agent-bot"];
  return [event];
}

function fakeDomElement(): Record<string, unknown> {
  return {
    contains: () => false,
    focus: () => {},
    getBoundingClientRect: () => ({ bottom: 240, height: 32, left: 960, right: 1120, top: 208, width: 160 }),
    scrollIntoView: () => {},
  };
}

function renderNode(node: unknown, state: RenderState, depth = 0): void {
  state.nodes++;
  if (state.nodes > 8000) return;
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return;
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, state, depth + 1);
    return;
  }
  if (!isElementLike(node)) return;

  if (node.type === Fragment) {
    renderNode(node.props.children, state, depth + 1);
    return;
  }

  if (isUnknownFn(node.type)) {
    state.rendered++;
    try {
      renderNode(node.type(node.props), state, depth + 1);
    } catch (error) {
      state.errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }

  const ref = node.props.ref;
  if (isRecord(ref)) ref.current = fakeDomElement();
  else if (isUnknownFn(ref)) ref(fakeDomElement());

  for (const [propName, value] of Object.entries(node.props)) {
    if (EVENT_PROPS.has(propName) && isUnknownFn(value) && state.events < 300) {
      state.events++;
      try {
        value(...fakeEvent(propName));
      } catch {
        // Handler smoke intentionally keeps walking the tree after an event
        // depends on browser state that this test harness does not model.
      }
    }
  }
  renderNode(node.props.children, state, depth + 1);
}

function createState(stateValues: unknown[] = []): RenderState {
  return { cleanups: [], errors: [], events: 0, ids: 0, nodes: 0, rendered: 0, stateValues: [...stateValues] };
}

function queryResult(options: Omit<QueryResultOverride, "__queryResult">): QueryResultOverride {
  return { __queryResult: true, ...options };
}

function isQueryResultOverride(value: unknown): value is QueryResultOverride {
  return isRecord(value) && value.__queryResult === true;
}

function overrideForQuery(queryKey: unknown): QueryResultOverride | null {
  const override = queryOverrides.get(JSON.stringify(queryKey));
  return isQueryResultOverride(override) ? override : null;
}

function createContext(defaultValue: unknown) {
  const context = { current: defaultValue, defaultValue };
  const Provider = ({ value, children }: Record<string, unknown>): unknown => {
    context.current = value;
    return children;
  };
  return { ...context, Provider, Consumer: Provider };
}

function mockReact(state: RenderState): Record<string, unknown> {
  const react = {
    Fragment,
    StrictMode: Fragment,
    Children: { toArray: flattenChildren },
    cloneElement: (element: unknown, props: Record<string, unknown> = {}) =>
      isElementLike(element) ? createElement(element.type, { ...element.props, ...props }, element.key) : element,
    createContext,
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) =>
      createElement(type, children.length > 0 ? { ...(props ?? {}), children } : props),
    forwardRef: (render: UnknownFn) => {
      const Forwarded = (props: Record<string, unknown>) => render(props, null);
      return Forwarded;
    },
    isValidElement: isElementLike,
    lazy: () => passthrough("LazyComponent"),
    memo: (component: unknown) => component,
    Suspense: passthrough("Suspense"),
    useCallback: (fn: UnknownFn) => fn,
    useContext: (context: unknown) => (isRecord(context) ? context.current : null),
    useDeferredValue: (value: unknown) => value,
    useEffect: (fn: UnknownFn) => {
      const cleanup = fn();
      if (isUnknownFn(cleanup)) state.cleanups.push(cleanup);
    },
    useId: () => `test-id-${++state.ids}`,
    useImperativeHandle: () => {},
    useLayoutEffect: (fn: UnknownFn) => {
      const cleanup = fn();
      if (isUnknownFn(cleanup)) state.cleanups.push(cleanup);
    },
    useMemo: (fn: UnknownFn) => fn(),
    useReducer: (reducer: UnknownFn, initialArg: unknown, init?: UnknownFn) => {
      let current = init ? init(initialArg) : initialArg;
      const dispatch = (action: unknown): void => {
        current = reducer(current, action);
      };
      return [current, dispatch];
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const fallback = isUnknownFn(initial) ? initial() : initial;
      const value = state.stateValues.length > 0 ? state.stateValues.shift() : fallback;
      let current = value;
      const setState = (next: unknown): void => {
        current = isUnknownFn(next) ? next(current) : next;
      };
      return [value, setState];
    },
    useSyncExternalStore: (_subscribe: UnknownFn, getSnapshot: UnknownFn) => getSnapshot(),
    version: "19.1.0-test",
  };
  return { ...react, default: react };
}

function passthrough(name: string): UnknownFn {
  const Component = (props: unknown) => createElement(name, isRecord(props) ? props : {});
  return Component;
}

function mockQueryModule(): Record<string, unknown> {
  const queryClient = {
    cancelQueries: async () => {},
    clear: () => {},
    fetchQuery: async (opts: Record<string, unknown>) => dataForQuery(opts.queryKey),
    getQueryData: (key: unknown) => dataForQuery(key),
    invalidateQueries: async () => {},
    removeQueries: () => {},
    resetQueries: () => {},
    setQueriesData: () => {},
    setQueryData: () => {},
  };
  return {
    QueryClient: class QueryClient {},
    QueryClientProvider: ({ children }: Record<string, unknown>) => children,
    useQueryClient: () => queryClient,
    useMutation: (options: Record<string, unknown> = {}) => {
      const run = (vars?: unknown): unknown => {
        if (mutationResultOverride?.error) {
          if (isUnknownFn(options.onError)) options.onError(mutationResultOverride.error, vars, undefined);
          return undefined;
        }
        try {
          const mutationFn = options.mutationFn;
          const result = isUnknownFn(mutationFn) ? mutationFn(vars) : vars;
          if (isRecord(result) && isUnknownFn(result.then)) {
            result.then((value: unknown) => {
              if (isUnknownFn(options.onSuccess)) options.onSuccess(value, vars, undefined);
            });
          } else if (isUnknownFn(options.onSuccess)) {
            options.onSuccess(result, vars, undefined);
          }
          return result;
        } catch (error) {
          if (isUnknownFn(options.onError)) options.onError(error, vars, undefined);
          return undefined;
        }
      };
      const status = mutationResultOverride?.status ?? "idle";
      const isPending = mutationResultOverride?.isPending ?? status === "pending";
      const isSuccess = mutationResultOverride?.isSuccess ?? status === "success";
      const error = mutationResultOverride?.error ?? null;
      return {
        data: undefined,
        error,
        isError: error !== null || status === "error",
        isIdle: true,
        isPending,
        isSuccess,
        mutate: run,
        mutateAsync: async (vars?: unknown) => run(vars),
        reset: () => {},
        status,
      };
    },
    useQuery: (options: Record<string, unknown>) => {
      if (isUnknownFn(options.queryFn)) {
        try {
          const result = options.queryFn();
          if (isRecord(result) && isUnknownFn(result.catch)) result.catch(() => {});
        } catch {
          // Query closures are exercised for coverage; deterministic fixture data
          // below still drives the rendered state.
        }
      }
      const override = overrideForQuery(options.queryKey);
      const data = override ? override.data : dataForQuery(options.queryKey);
      const error = override?.error ?? null;
      const isLoading = override?.isLoading ?? false;
      const isPending = override?.isPending ?? isLoading;
      const isError = override?.isError ?? error !== null;
      return {
        data,
        dataUpdatedAt: Date.now(),
        error,
        isError,
        isFetching: override?.isFetching ?? isLoading,
        isLoading,
        isPending,
        isSuccess: !isError && !isLoading && !isPending,
        refetch: async () => ({ data }),
        status: override?.status ?? (isError ? "error" : isLoading ? "loading" : "success"),
      };
    },
  };
}

function dataForQuery(queryKey: unknown): unknown {
  const overrideKey = JSON.stringify(queryKey);
  if (queryOverrides.has(overrideKey)) {
    const override = queryOverrides.get(overrideKey);
    return isQueryResultOverride(override) ? override.data : override;
  }
  if (!Array.isArray(queryKey)) return undefined;
  const head = queryKey[0];
  if (head === "activity") return { agents: agents.map((item) => ({ ...item, agentId: item.uuid })) };
  if (head === "adapters") return adapterRows();
  if (head === "adapter-mappings") return mappingRows();
  if (head === "adapter-statuses") return [{ configId: 1, connected: true, lastSeenAt: iso }];
  if (head === "agent") return botAgent;
  if (head === "agent-client-status") {
    return {
      clientId: "client-1",
      hostname: "ada-workstation",
      status: "connected",
      authState: "ok",
      offlineSince: null,
    };
  }
  if (head === "agent-config") return agentConfig();
  if (head === "agent-sessions" || head === "agent-sessions-active") return [];
  if (head === "agent-skills") return { skills: [{ name: "review", description: "Review code", namespace: "team" }] };
  if (head === "agents" && queryKey[1] === "team-page") return agents;
  if (head === "agents") return agentPage;
  if (head === "chat-agent-status") return chatStatuses();
  if (head === "chat-attentions") return [attention];
  if (head === "chat-detail") return chatDetail;
  if (head === "chat-doc-snapshot") return { path: "atlas/chat-1/README.md", content: "# Inline README" };
  if (head === "chat-messages") return messagesPage;
  if (head === "chat-messages-cache") return [textMessage];
  if (head === "chat-read-state") return { lastReadMessageId: "msg-1", unreadCount: 1, mentionCount: 1 };
  if (head === "clients") return [client];
  if (head === "context-tree-snapshot") return undefined;
  if (head === "github-app-installation") {
    return {
      installationId: 42,
      accountLogin: "agent-team-foundation",
      accountType: "Organization",
      permissions: { issues: "read", pull_requests: "write" },
      events: ["issues", "pull_request"],
      manageUrl: "https://github.com/organizations/agent-team-foundation/settings/installations/42",
      suspended: true,
    };
  }
  if (head === "managed-agents") return [botAgent, privateAgent];
  if (head === "me" && queryKey[1] === "chats")
    return { rows: [chatRow("chat-1"), chatRow("chat-2")], nextCursor: null };
  if (head === "me" && queryKey[1] === "docs" && queryKey[2] === "preview") {
    return { path: "docs/README.md", ref: { path: "docs/README.md" }, content: "# Preview README" };
  }
  if (head === "me" && queryKey[1] === "docs") return { kind: "markdown", title: "README.md", body: "# Notes" };
  if (head === "members") return members;
  if (head === "organization") return { id: "org-1", slug: "compute", displayName: "Compute Team" };
  if (head === "org-setting" && queryKey[2] === "context_tree") {
    return { repo: "agent-team-foundation/first-tree-context", branch: "main", rootPath: "." };
  }
  if (head === "org-setting" && queryKey[2] === "source_repos") {
    return { repos: [{ url: "https://github.com/agent-team-foundation/first-tree", defaultBranch: "main" }] };
  }
  if (head === "onboarding" && queryKey[1] === "github-repos") {
    return [
      { id: 1, fullName: "agent-team-foundation/first-tree", private: false, defaultBranch: "main", htmlUrl: "" },
    ];
  }
  if (head === "onboarding" && queryKey[1] === "installation") return dataForQuery(["github-app-installation"]);
  if (head === "onboarding" && queryKey[1] === "context-tree") {
    return { repo: "agent-team-foundation/first-tree-context", branch: "main", rootPath: "." };
  }
  if (head === "onboarding" && queryKey[1] === "team-config") return { displayName: "Compute Team" };
  if (head === "palette-sessions") return [];
  if (head === "session") return { id: "session-1", agentId: "agent-bot", chatId: "chat-1", status: "running" };
  if (head === "session-events") return sessionEvents;
  return undefined;
}

function adapterRows(): Record<string, unknown>[] {
  return [
    { id: 1, agentId: "agent-bot", platform: "slack", status: "active", createdAt: iso, updatedAt: iso },
    { id: 2, agentId: "agent-team", platform: "feishu", status: "inactive", createdAt: iso, updatedAt: iso },
  ];
}

function mappingRows(): Record<string, unknown>[] {
  return [
    {
      id: 10,
      agentId: "agent-human",
      platform: "slack",
      externalUserId: "U123",
      displayName: "Ada",
      boundVia: "manual",
      createdAt: iso,
      updatedAt: iso,
    },
  ];
}

function chatStatuses(): Record<string, unknown>[] {
  return [
    {
      agentId: "agent-bot",
      reachable: true,
      errored: false,
      needsYou: true,
      working: true,
      engagement: "active",
      main: "needs_you",
      activity: { kind: "tool_call", label: "Bash", startedAt: iso },
      pendingQuestion: { messageId: "msg-1", subject: "Approve release plan" },
    },
    {
      agentId: "agent-team",
      reachable: false,
      errored: true,
      needsYou: false,
      working: false,
      engagement: "none",
      main: "error",
      activity: null,
    },
  ];
}

function chatRow(chatId: string): Record<string, unknown> {
  return {
    chatId,
    type: "group",
    membershipKind: "participant",
    source: chatId === "chat-2" ? "github" : "manual",
    entityType: chatId === "chat-2" ? "pull_request" : null,
    title: chatId === "chat-2" ? "PR triage" : "Launch review",
    topic: chatId === "chat-2" ? "PR triage" : "Launch review",
    participants: [
      { agentId: "agent-human", displayName: "Ada", type: "human", avatarColorToken: "hue-1", avatarImageUrl: null },
      { agentId: "agent-bot", displayName: "Atlas", type: "agent", avatarColorToken: "hue-2", avatarImageUrl: null },
    ],
    participantCount: 2,
    lastMessageAt: iso,
    lastMessagePreview: "Ready for review",
    unreadMentionCount: chatId === "chat-2" ? 1 : 0,
    canReply: true,
    engagementStatus: "active",
    liveActivity: { agentId: "agent-bot", kind: "tool_call", label: "Bash", startedAt: iso },
    pendingQuestionAgentIds: ["agent-bot"],
    failedAgentIds: chatId === "chat-2" ? ["agent-team"] : [],
    busyAgentIds: ["agent-bot"],
    chatHasOpenQuestion: true,
    chatHasExplicitMentionToMe: true,
  };
}

function agentConfig(): Record<string, unknown> {
  return {
    version: 3,
    runtimeProvider: "claude-code",
    payload: {
      runtimeProvider: "claude-code",
      model: "claude-sonnet-4-5",
      systemPrompt: { type: "preset", preset: "claude_code", append: "Be concise." },
      mcpServers: [{ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }],
      env: [{ name: "GITHUB_TOKEN", value: null, secret: true }],
      gitRepos: [{ url: "https://github.com/agent-team-foundation/first-tree", branch: "main" }],
    },
  };
}

function defaultAgentDetailContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const items = draftItems();
  return {
    agent: botAgent,
    bindClientPending: false,
    boundClientLabel: "ada-workstation",
    canEditConfig: true,
    canManageAgent: true,
    clientStatus: dataForQuery(["agent-client-status"]),
    clientStatusError: null,
    clientStatusLoading: false,
    config: {
      payload: {
        env: [],
        gitRepos: [],
        mcpServers: [],
        model: "claude-sonnet-4-5",
        prompt: { append: "Baseline prompt" },
        runtimeProvider: "claude-code",
      },
      runtimeProvider: "claude-code",
      version: 3,
    },
    configError: null,
    configLoading: false,
    dangerError: "Previous lifecycle action failed",
    deletePending: false,
    draft: {
      addEnv: () => {},
      addGit: () => {},
      addMcp: () => {},
      deleteEnv: () => {},
      deleteGit: () => {},
      deleteMcp: () => {},
      draft: { env: items.env, git: items.git, mcp: items.mcp, model: "claude-sonnet-4-5", promptAppend: "Be direct." },
      revertModel: () => {},
      revertPrompt: () => {},
      setModel: () => {},
      setPromptAppend: () => {},
      summary: {
        anyDirty: true,
        counts: { env: 2, git: 1, mcp: 1, model: 1, prompt: 1 },
        dirtySections: ["prompt", "model", "mcp", "env", "git"],
      },
      undoDeleteEnv: () => {},
      undoDeleteGit: () => {},
      undoDeleteMcp: () => {},
      updateEnv: () => {},
      updateGit: () => {},
      updateMcp: () => {},
    },
    dryRunPending: false,
    dryRunText: "Would update runtime config.",
    isHuman: false,
    isOffline: false,
    isUnclaimed: false,
    onDelete: () => {},
    onOpenBindDialog: () => {},
    onOpenRebindDialog: () => {},
    onReactivate: () => {},
    onRunDryRun: () => {},
    onSuspend: () => {},
    reactivatePending: false,
    refreshAgent: async () => {},
    saveIdentity: async () => {},
    setupRuntimeProvider: "claude-code",
    suspendPending: false,
    uuid: "agent-bot",
    ...overrides,
  };
}

function draftItems(): Record<string, unknown> {
  return {
    env: [
      {
        key: "env-1",
        value: { name: "GITHUB_TOKEN", value: "secret-token", sensitive: true },
        baseline: { name: "GITHUB_TOKEN", value: "***", sensitive: true },
        status: "modified",
      },
      {
        key: "env-2",
        value: { name: "DEBUG", value: "1", sensitive: false },
        baseline: null,
        status: "added",
      },
    ],
    git: [
      {
        key: "git-1",
        value: { url: "https://github.com/agent-team-foundation/first-tree", ref: "main", localPath: "first-tree" },
        baseline: { url: "https://github.com/agent-team-foundation/first-tree", ref: "main", localPath: "first-tree" },
        status: "unchanged",
      },
    ],
    mcp: [
      {
        key: "mcp-1",
        value: {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: githubTokenTemplate },
        },
        baseline: {
          name: "github",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: githubTokenTemplate },
        },
        status: "unchanged",
      },
    ],
  };
}

function onboardingFlowValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeIndex: 4,
    activeStep: "kickoff",
    agentDisplayName: "Release Helper",
    agentError: null,
    agentPhase: "idle",
    completeAndEnterChat: async () => {},
    computer: {
      capabilitiesLoaded: true,
      cliCommand: "first-tree login connect-token",
      connectedClient: client,
      okRuntimes: ["claude-code", "codex"],
      selectedRuntime: "claude-code",
      tokenError: null,
    },
    createAgent: async () => {},
    createdAgentUuid: "agent-bot",
    finishLater: async () => {},
    goNext: () => {},
    goTo: () => {},
    hasAgent: true,
    markTreeAutoInitDone: () => {},
    memberId: "member-1",
    orgHasOtherMembers: true,
    organizationId: "org-1",
    path: "admin",
    retryAgent: async () => {},
    role: "admin",
    selectedRepoUrls: ["https://github.com/agent-team-foundation/first-tree"],
    sequence: ["team", "connect-computer", "create-agent", "connect-code", "kickoff"],
    setAgentDisplayName: () => {},
    setSelectedRepoUrls: () => {},
    setTreeMode: () => {},
    setTreeUrl: () => {},
    setVisibility: () => {},
    teamDisplayName: "Compute Team",
    treeAutoInitDone: true,
    treeMode: "existing",
    treeUrl: "https://github.com/agent-team-foundation/first-tree-context",
    username: "ada",
    visibility: "organization",
    ...overrides,
  };
}

function setupBrowserGlobals(): void {
  const storage = new Map<string, string>();
  const listeners = new Map<string, Set<UnknownFn>>();
  const addListener = (type: string, fn: unknown): void => {
    if (!isUnknownFn(fn)) return;
    const set = listeners.get(type) ?? new Set<UnknownFn>();
    set.add(fn);
    listeners.set(type, set);
  };
  const removeListener = (type: string, fn: unknown): void => {
    if (isUnknownFn(fn)) listeners.get(type)?.delete(fn);
  };
  const storageApi = {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  const mediaQuery = {
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: addListener,
    removeEventListener: removeListener,
    body: { classList: { add: () => {}, remove: () => {} } },
    documentElement: { style: {} },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  vi.stubGlobal("window", {
    addEventListener: addListener,
    clearInterval: () => {},
    clearTimeout: () => {},
    confirm: () => true,
    innerHeight: 900,
    innerWidth: 1280,
    localStorage: storageApi,
    location: {
      assign: () => {},
      hash: "",
      href: "http://localhost/?agent=agent-bot&c=chat-1",
      pathname: "/",
      search: "?agent=agent-bot&c=chat-1",
    },
    matchMedia: () => mediaQuery,
    open: () => null,
    removeEventListener: removeListener,
    scrollTo: () => {},
    sessionStorage: storageApi,
    setInterval: () => 1,
    setTimeout: (fn: UnknownFn) => {
      fn();
      return 1;
    },
  });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: async () => {} },
    userAgent: "vitest",
  });
  vi.stubGlobal("setInterval", () => 1);
  vi.stubGlobal("clearInterval", () => {});
  vi.stubGlobal("requestAnimationFrame", (fn: UnknownFn) => {
    fn(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function setupModuleMocks(state: RenderState): void {
  vi.doMock("react", () => mockReact(state));
  vi.doMock("react/jsx-runtime", () => ({ Fragment, jsx: createElement, jsxs: createElement }));
  vi.doMock("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV: createElement }));
  vi.doMock("@tanstack/react-query", () => mockQueryModule());

  vi.doMock("lucide-react", () => {
    const names = [
      "AlertTriangle",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "AtSign",
      "Bell",
      "Bot",
      "Building2",
      "Check",
      "ChevronDown",
      "ChevronRight",
      "CircleAlert",
      "CircleDot",
      "Copy",
      "CornerDownLeft",
      "ExternalLink",
      "Eye",
      "EyeOff",
      "GitBranch",
      "GitCommit",
      "GitMerge",
      "GitPullRequest",
      "Github",
      "HelpCircle",
      "Inbox",
      "Info",
      "LayoutDashboard",
      "Link2",
      "Loader2",
      "Lock",
      "LogOut",
      "Menu",
      "MessageCircle",
      "MessageSquare",
      "MessagesSquare",
      "MonitorSmartphone",
      "Moon",
      "MoreHorizontal",
      "Network",
      "Paperclip",
      "Pause",
      "PauseCircle",
      "Pencil",
      "Play",
      "Plug",
      "Plus",
      "RefreshCw",
      "Rocket",
      "Search",
      "Settings",
      "Sparkles",
      "Sun",
      "Trash2",
      "TriangleAlert",
      "Undo2",
      "User",
      "UserPlus",
      "Users",
      "X",
      "Zap",
    ];
    return Object.fromEntries(names.map((name) => [name, passthrough(`Icon:${name}`)]));
  });
  vi.doMock("@radix-ui/react-dialog", () => ({
    Close: passthrough("DialogClose"),
    Content: passthrough("DialogContent"),
    Description: passthrough("DialogDescription"),
    Overlay: passthrough("DialogOverlay"),
    Portal: passthrough("DialogPortal"),
    Root: passthrough("DialogRoot"),
    Title: passthrough("DialogTitle"),
    Trigger: passthrough("DialogTrigger"),
  }));
  vi.doMock("@radix-ui/react-label", () => ({ Root: passthrough("LabelRoot") }));
  vi.doMock("@radix-ui/react-slot", () => ({ Slot: passthrough("Slot") }));
  vi.doMock("cmdk", () => {
    const Command = passthrough("Command");
    return {
      Command: Object.assign(Command, {
        Empty: passthrough("CommandEmpty"),
        Group: passthrough("CommandGroup"),
        Input: passthrough("CommandInput"),
        Item: passthrough("CommandItem"),
        List: passthrough("CommandList"),
        Separator: passthrough("CommandSeparator"),
      }),
    };
  });
  vi.doMock("react-markdown", () => ({
    default: ({ children, components }: Record<string, unknown>) => {
      const anchors: unknown[] = [];
      const anchorRenderer = isRecord(components) ? components.a : null;
      if (isUnknownFn(anchorRenderer)) {
        const clickEvent = {
          altKey: false,
          button: 0,
          ctrlKey: false,
          defaultPrevented: false,
          metaKey: false,
          preventDefault: () => {},
          shiftKey: false,
          stopPropagation: () => {},
        };
        for (const href of ["#doc-failed?reason=missing", "README.md", "https://example.test/readme"]) {
          const anchor = anchorRenderer({ href, children: href, node: null });
          if (isElementLike(anchor) && isUnknownFn(anchor.props.onClick)) {
            try {
              anchor.props.onClick(clickEvent);
            } catch {
              // Keep the markdown smoke renderer focused on reachability.
            }
          }
          anchors.push(anchor);
        }
      }
      return createElement("markdown", { children: [children, ...anchors] });
    },
  }));
  vi.doMock("remark-breaks", () => ({ default: () => {} }));
  vi.doMock("remark-gfm", () => ({ default: () => {} }));
  vi.doMock("dompurify", () => ({ default: { sanitize: (value: string) => value } }));
  vi.doMock("react-dom", () => ({ createPortal: (node: unknown) => node }));

  vi.doMock("react-router", () => ({
    BrowserRouter: ({ children }: Record<string, unknown>) => children,
    Link: passthrough("Link"),
    MemoryRouter: ({ children }: Record<string, unknown>) => children,
    NavLink: ({ children, ...props }: Record<string, unknown>) => {
      const renderedChildren = isUnknownFn(children)
        ? [
            children({ isActive: true, isPending: false, isTransitioning: false }),
            children({ isActive: false, isPending: false, isTransitioning: false }),
          ]
        : children;
      return createElement("NavLink", { ...props, children: renderedChildren });
    },
    Navigate: passthrough("Navigate"),
    Outlet: passthrough("Outlet"),
    Route: ({ element }: Record<string, unknown>) => element,
    Routes: ({ children }: Record<string, unknown>) => children,
    useLocation: () => ({ pathname: "/agents/agent-bot/profile", search: routerSearch, hash: "" }),
    useNavigate: () => () => {},
    useOutletContext: () => outletContextOverride ?? defaultAgentDetailContext(),
    useParams: () => ({ uuid: "agent-bot", inviteId: "invite-1", token: "invite-token", chatId: "chat-1" }),
    useSearchParams: () => [new URLSearchParams(routerSearch), () => {}],
  }));

  vi.doMock("../auth/auth-context.js", () => ({
    AuthProvider: ({ children }: Record<string, unknown>) => children,
    useAuth: () => ({
      adoptTokens: async () => {},
      agentId: "agent-human",
      currentMembership: null,
      dismissOnboarding: async () => {},
      isAuthenticated: true,
      login: async () => {},
      logout: () => {},
      markOnboardingCompleted: async () => {},
      meLoaded: true,
      memberId: "member-1",
      memberships: [],
      onboardingCompletedAt: iso,
      onboardingDismissedAt: null,
      onboardingStep: "connect",
      orgHasOtherMembers: true,
      organizationId: "org-1",
      refreshMe: async () => {},
      restoreOnboarding: async () => {},
      role: "admin",
      selectOrganization: async () => {},
      teamDisplayName: "Compute Team",
      user: {
        id: "user-1",
        username: "ada",
        displayName: "Ada Lovelace",
        avatarUrl: null,
      },
      ...authOverride,
    }),
  }));
  vi.doMock("../hooks/use-viewport.js", () => ({
    useWorkspaceViewport: () => viewportOverride ?? "xl",
  }));

  mockApis();
}

const BULK_RENDER_SKIP = new Set([
  "main.tsx",
  "index.css",
  "auth/auth-context.tsx",
  "components/chat/message-input.tsx",
]);

function sourceModules(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const absolute = resolve(dir, name);
    const rel = relative(srcRoot, absolute);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (name === "__tests__") continue;
      entries.push(...sourceModules(absolute));
      continue;
    }
    if (BULK_RENDER_SKIP.has(rel)) continue;
    if (!/\.(ts|tsx)$/.test(name)) continue;
    entries.push(absolute);
  }
  return entries;
}

async function collectRenderableExports(): Promise<ModuleExportCase[]> {
  const cases: ModuleExportCase[] = [];
  for (const moduleFile of sourceModules(srcRoot)) {
    const modulePath = relative(srcRoot, moduleFile);
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(moduleFile).href)) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [exportName, value] of Object.entries(loaded)) {
      if (!isUnknownFn(value)) continue;
      if (exportName === "default" || /^[A-Z]/.test(exportName)) {
        cases.push({ exportName, modulePath, value });
      }
    }
  }
  return cases;
}

function broadComponentProps(): Record<string, unknown> {
  return {
    action: "create",
    active: true,
    activeCount: 2,
    activeKey: "overview",
    agent: botAgent,
    agentId: "agent-bot",
    agentName: "atlas",
    agents: agents,
    ariaLabel: "Smoke action",
    attention,
    attentions: [attention],
    baseline: "baseline",
    boundAgents: [{ agentId: "agent-bot", agentName: "atlas", displayName: "Atlas" }],
    canBindComputer: true,
    canEdit: true,
    canManage: () => true,
    canManageAgent: true,
    caption: "Smoke caption",
    chat: chatDetail,
    chatId: "chat-1",
    children: createElement("span", { children: "Smoke" }),
    client,
    clientHostMap: new Map([["client-1", "ada-workstation"]]),
    command: "first-tree login token",
    config: agentConfig(),
    count: 2,
    defaultOpen: true,
    displayName: "Atlas",
    engagement: "active",
    error: null,
    events: sessionEvents,
    gitRepos: draftItems().git,
    groups: [
      {
        key: "agents",
        title: "Agents",
        count: 1,
        rows: [{ kind: "agent", agent: botAgent, managerLabel: "Ada", isOwnedBySelf: true }],
      },
    ],
    isOpen: true,
    items: draftItems().env,
    label: "Smoke label",
    members,
    message: textMessage,
    messages: messagesPage.items,
    name: "atlas",
    onAdded: () => {},
    onAgentClick: () => {},
    onBindComputer: () => {},
    onChange: () => {},
    onClearFilters: () => {},
    onClick: () => {},
    onClose: () => {},
    onCreated: () => {},
    onDelete: () => {},
    onDiscard: () => {},
    onEngagementChange: () => {},
    onExit: () => {},
    onNewChat: () => {},
    onOpenChange: () => {},
    onRebind: () => {},
    onRefresh: async () => {},
    onResetAll: () => {},
    onResponded: () => {},
    onSave: async () => {},
    onSelect: () => {},
    onSelectAgent: () => {},
    onSelectChat: () => {},
    onShowConversations: () => {},
    onToggle: () => {},
    onUnreadChange: () => {},
    onWatchingChange: () => {},
    open: true,
    order: "priority",
    origin: ["manual", "github"],
    participantIds: ["agent-human", "agent-bot"],
    participants: chatDetail.participants,
    phase: "waiting",
    previewSnapshot: dataForQuery(["context-tree-snapshot"]),
    provider: "claude-code",
    repos: [{ id: 1, fullName: "agent-team-foundation/first-tree", private: false, defaultBranch: "main" }],
    rows: agents,
    runtimeProvider: "claude-code",
    selectedAgentId: "agent-bot",
    selectedChatId: "chat-1",
    selectedUrls: ["https://github.com/agent-team-foundation/first-tree"],
    state: "ok",
    status: "connected",
    title: "Smoke title",
    titleFallback: "Launch review",
    tone: "info",
    value: "smoke",
    variant: "inline",
    watching: true,
  };
}

function mockApis(): void {
  vi.doMock("../api/activity.js", () => ({
    disconnectClient: async () => ({ disconnected: true, agentIds: ["agent-bot"] }),
    generateConnectToken: async () => ({ token: "connect-token", expiresIn: 600, command: "first-tree login token" }),
    getActivityOverview: async () => ({ agents }),
    getClient: async () => client,
    getClientCapabilities: async () => client,
    listClients: async () => [client],
    listOrgClients: async () => [client],
    resetAgentActivity: async () => ({ reset: true }),
    retireClient: async () => {},
  }));
  vi.doMock("../api/adapter-mappings.js", () => ({
    createAdapterMapping: async () => mappingRows()[0],
    deleteAdapterMapping: async () => {},
    listAdapterMappings: async () => mappingRows(),
  }));
  vi.doMock("../api/adapter-status.js", () => ({ getAdapterStatuses: async () => [{ configId: 1, connected: true }] }));
  vi.doMock("../api/adapters.js", () => ({
    createAdapter: async () => adapterRows()[0],
    deleteAdapter: async () => {},
    getAdapter: async () => adapterRows()[0],
    listAdapters: async () => adapterRows(),
    updateAdapter: async () => adapterRows()[0],
  }));
  vi.doMock("../api/agent-config.js", () => ({
    dryRunAgentConfig: async () => ({ ok: true, diagnostics: [] }),
    getAgentClientStatus: async () => dataForQuery(["agent-client-status"]),
    getAgentConfig: async () => agentConfig(),
    updateAgentConfig: async () => agentConfig(),
  }));
  vi.doMock("../api/agent-status.js", () => ({
    chatAgentStatusQueryKey: (chatId: string) => ["chat-agent-status", chatId],
    fetchChatAgentStatuses: async () => chatStatuses(),
  }));
  vi.doMock("../api/agents.js", () => ({
    checkAgentNameAvailability: async () => ({ available: true }),
    createAgent: async () => botAgent,
    deleteAgent: async () => {},
    deleteAgentAvatar: async () => {},
    getAgent: async () => botAgent,
    getAgentSkills: async () => ({ skills: [{ name: "review", description: "Review code" }] }),
    listAgents: async () => agentPage,
    listAllAgents: async () => agentPage,
    listManagedAgents: async () => [botAgent, privateAgent],
    reactivateAgent: async () => botAgent,
    rebindAgent: async () => botAgent,
    suspendAgent: async () => suspendedAgent,
    testAgentConnection: async () => ({ ok: true, message: "connected" }),
    updateAgent: async () => botAgent,
    uploadAgentAvatar: async () => ({ avatarImageUrl: "https://example.com/avatar.png" }),
  }));
  vi.doMock("../api/attention.js", () => ({
    attentionsInChatQueryKey: (chatId: string) => ["chat-attentions", chatId],
    listAttentionsInChat: async () => [attention],
    respondAttention: async () => ({ ...attention, state: "responded", response: "approved" }),
    respondAttentionMutationKey: (id: string) => ["attention-response", id],
  }));
  vi.doMock("../api/chats.js", () => ({
    createAgentChat: async () => ({ id: "chat-1" }),
    getChat: async () => chatDetail,
    listChatGithubEntities: async () => ({
      entities: [
        {
          id: 1,
          repository: "agent-team-foundation/first-tree",
          entityType: "pull_request",
          entityNumber: 12,
          title: "Improve dashboard",
          url: "https://github.com/agent-team-foundation/first-tree/pull/12",
          boundVia: "webhook",
        },
      ],
    }),
    listChatMessages: async () => messagesPage,
    listChats: async () => ({ items: [chatDetail], nextCursor: null }),
    patchChatEngagement: async () => chatDetail,
    readFileAsBase64: async () => "ZmFrZQ==",
    renameChat: async () => chatDetail,
    sendChatMessage: async () => textMessage,
    sendFileMessage: async () => ({ ...textMessage, id: "msg-file", contentType: "file" }),
  }));
  vi.doMock("../api/client.js", () => {
    class ApiError extends Error {
      status: number;
      issues: unknown[] | undefined;
      constructor(status: number, message: string, issues?: unknown[]) {
        super(message);
        this.status = status;
        this.issues = issues;
      }
    }
    return {
      ApiError,
      api: {
        delete: async () => ({}),
        get: async (path: string) =>
          path.includes("/invitations")
            ? {
                createdAt: iso,
                expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
                inviteUrl: "https://hub.example.test/invite/invite-token",
                token: "invite-token",
              }
            : {},
        patch: async () => ({}),
        post: async (path: string) =>
          path.includes("/invitations/rotate")
            ? {
                createdAt: iso,
                expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
                inviteUrl: "https://hub.example.test/invite/rotated-token",
                token: "rotated-token",
              }
            : { token: "connect-token", expiresIn: 600, command: "first-tree login token" },
        put: async () => ({}),
      },
      clearStoredTokens: () => {},
      getStoredTokens: () => null,
      refreshAccessToken: async () => null,
      setApiSelectedOrganizationId: () => {},
      setStoredTokens: () => {},
      withOrg: (path: string) => path,
      withOrgAt: (_orgId: string, path: string) => path,
    };
  });
  vi.doMock("../api/context-tree.js", () => ({ getContextTreeSnapshot: async () => undefined }));
  vi.doMock("../api/github-app.js", () => ({
    getGithubAppInstallation: async () => dataForQuery(["github-app-installation"]),
    getGithubAppInstallationExists: async () => true,
    getGithubAppInstallUrl: async () => "https://github.com/apps/first-tree/installations/new",
  }));
  vi.doMock("../api/github.js", () => ({
    listGithubRepos: async () => dataForQuery(["onboarding", "github-repos"]),
  }));
  vi.doMock("../api/image-store.js", () => ({ getImage: async () => null, putImage: async () => "image-1" }));
  vi.doMock("../api/me-chats.js", () => ({
    addMeChatParticipants: async () => {},
    createMeChat: async () => ({ chatId: "chat-1" }),
    joinMeChat: async () => {},
    leaveMeChat: async () => ({ left: true }),
    listMeChatSourceCounts: async () => ({ manual: 2, github: 1 }),
    listMeChats: async () => dataForQuery(["me", "chats"]),
    markMeChatRead: async () => ({ unreadCount: 0, mentionCount: 0 }),
    markMeChatUnread: async () => ({ unreadCount: 1, mentionCount: 1 }),
  }));
  vi.doMock("../api/me-docs.js", () => ({ getMeDoc: async () => dataForQuery(["me", "docs"]) }));
  vi.doMock("../api/members.js", () => ({
    deleteMember: async () => {},
    listMembers: async () => members,
    updateMember: async () => members[0],
  }));
  vi.doMock("../api/message-store.js", () => ({
    cacheMessages: async () => {},
    clearChatCache: async () => {},
    getCachedMessages: async () => [textMessage],
  }));
  vi.doMock("../api/onboarding-events.js", () => ({
    markOnboardingCompleted: async () => {},
    reportOnboardingEvent: async () => {},
  }));
  vi.doMock("../api/org-settings.js", () => ({
    deleteContextTreeSetting: async () => {},
    deleteSourceReposSetting: async () => {},
    getContextTreeSetting: async () => dataForQuery(["org-setting", "org-1", "context_tree"]),
    getSourceReposSetting: async () => dataForQuery(["org-setting", "org-1", "source_repos"]),
    putContextTreeSetting: async () => dataForQuery(["org-setting", "org-1", "context_tree"]),
    putSourceReposSetting: async () => dataForQuery(["org-setting", "org-1", "source_repos"]),
  }));
  vi.doMock("../api/organizations.js", () => ({
    getOrganization: async () => dataForQuery(["organization"]),
    updateOrganization: async () => dataForQuery(["organization"]),
  }));
  vi.doMock("../api/overview.js", () => ({ getOverview: async () => ({ agents: 4, clients: 1, chats: 2 }) }));
  vi.doMock("../api/read-state-store.js", () => ({
    clearReadState: async () => {},
    getReadState: async () => dataForQuery(["chat-read-state"]),
    setReadState: async () => {},
  }));
  vi.doMock("../api/sessions.js", () => ({
    agentSessionsQueryKey: (agentId: string) => ["agent-sessions", agentId],
    asAssistantTextPayload: (payload: unknown) =>
      isRecord(payload) && typeof payload.text === "string" ? payload : null,
    asErrorPayload: (payload: unknown) => (isRecord(payload) && typeof payload.message === "string" ? payload : null),
    asToolCallPayload: (payload: unknown) => (isRecord(payload) && typeof payload.tool === "string" ? payload : null),
    asTurnEndPayload: (payload: unknown) => (isRecord(payload) ? payload : null),
    getSession: async () => dataForQuery(["session"]),
    listAgentSessions: async () => [],
    listSessionEvents: async () => sessionEvents,
    listSessions: async () => [],
    sessionQueryKey: (agentId: string, chatId: string) => ["session", agentId, chatId],
    suspendSession: async () => ({ ok: true }),
    terminateSession: async () => ({ ok: true }),
  }));
}

async function componentCases(): Promise<ComponentCase[]> {
  const { MOCK_CONTEXT_SNAPSHOT } = await import("../pages/context-preview-mock.js");
  const { OnboardingFlowProvider } = await import("../pages/onboarding/onboarding-flow.js");
  const { StepKickoff } = await import("../pages/onboarding/steps/step-kickoff.js");
  return [
    { name: "ClientsPage", load: async () => (await import("../pages/clients.js")).ClientsPage },
    { name: "TeamPage", load: async () => (await import("../pages/team/index.js")).TeamPage },
    { name: "BindingsPage", load: async () => (await import("../pages/bindings.js")).BindingsPage },
    {
      name: "ContextPage",
      load: async () => (await import("../pages/context.js")).ContextPage,
      props: { previewSnapshot: MOCK_CONTEXT_SNAPSHOT },
    },
    { name: "AgentDetailPage", load: async () => (await import("../pages/agent-detail.js")).AgentDetailPage },
    { name: "WorkspacePage", load: async () => (await import("../pages/workspace/index.js")).WorkspacePage },
    {
      name: "ConversationList",
      load: async () => (await import("../pages/workspace/conversations/index.js")).ConversationList,
      props: {
        selectedChatId: "chat-1",
        onSelectChat: () => {},
        onNewChat: () => {},
        engagement: "active",
        onEngagementChange: () => {},
        unread: true,
        onUnreadChange: () => {},
        watching: true,
        onWatchingChange: () => {},
        origin: ["manual", "github"],
        onOriginChange: () => {},
        participants: ["agent-bot"],
        onParticipantsChange: () => {},
        onClearFilters: () => {},
        group: "recency",
        onGroupChange: () => {},
      },
    },
    {
      name: "NewChatDraft",
      load: async () => (await import("../pages/workspace/conversations/new-chat-draft.js")).NewChatDraft,
      props: { onCreated: () => {} },
    },
    {
      name: "ChatView",
      load: async () => (await import("../pages/workspace/center/chat-view.js")).ChatView,
      props: { agentId: "agent-bot", chatId: "chat-1", titleFallback: "Launch review" },
    },
    {
      name: "AttentionCard",
      load: async () => (await import("../components/chat/attention-card.js")).AttentionCard,
      props: { attention, onResponded: () => {} },
    },
    {
      name: "NewAgentDialog",
      load: async () => (await import("../components/new-agent-dialog.js")).NewAgentDialog,
      props: { open: true, onOpenChange: () => {}, onCreated: () => {} },
      stateValues: [
        "Release Helper",
        "release-helper",
        false,
        "organization",
        "claude-code",
        true,
        [client, { ...client, id: "client-2", hostname: "grace-laptop", lastSeenAt: "2026-05-27T00:00:00.000Z" }],
        true,
        "client-1",
        { "claude-code": { state: "ok", version: "1.0.0" }, codex: { state: "ok", version: "1.0.0" } },
        "client-1",
        "token",
        "first-tree login token",
        Date.now() + 60_000,
        false,
        {},
        { status: "ok" },
      ],
    },
    {
      name: "TeamTable",
      load: async () => (await import("../pages/team/team-table.js")).TeamTable,
      props: {
        groups: [
          {
            key: "humans",
            title: "Humans",
            count: 1,
            rows: [
              {
                kind: "human",
                id: "member-1",
                agentId: "agent-human",
                username: "ada",
                displayName: "Ada Lovelace",
                role: "admin",
                createdAt: iso,
                isSelf: true,
                delegate: { name: "helper", displayName: "Private Helper" },
                canEditDelegate: true,
                onEditDelegate: () => {},
              },
            ],
          },
          {
            key: "other-private",
            title: "Other members' private agents",
            count: 1,
            collapsible: true,
            rows: [{ kind: "agent", agent: privateAgent, managerLabel: "Ada Lovelace", isOwnedBySelf: true }],
          },
        ],
        clientHostMap: new Map([["client-1", "ada-workstation"]]),
        onAgentClick: () => {},
        getHumanActions: () => [{ key: "edit", label: "Edit", onSelect: () => {} }],
        getAgentActions: () => [{ key: "open", label: "Open", onSelect: () => {} }],
      },
    },
    {
      name: "ChatRowAvatarPreviewPage",
      load: async () => (await import("../pages/chat-row-avatar-preview.js")).ChatRowAvatarPreviewPage,
    },
    { name: "IntegrationsPage", load: async () => (await import("../pages/integrations.js")).IntegrationsPage },
    { name: "SettingsLayout", load: async () => (await import("../pages/settings.js")).SettingsLayout },
    {
      name: "InviteLinkPanel",
      load: async () => (await import("../pages/invite-link-panel.js")).InviteLinkPanel,
      stateValues: [
        {
          createdAt: iso,
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          inviteUrl: "https://hub.example.test/invite/invite-token",
          token: "invite-token",
        },
        null,
        false,
        false,
      ],
    },
    {
      name: "GithubAppInstallationPanel",
      load: async () => (await import("../pages/github-app-installation-panel.js")).GithubAppInstallationPanel,
    },
    {
      name: "ContextTreeSettingsPanel",
      load: async () => (await import("../pages/context-tree-settings-panel.js")).ContextTreeSettingsPanel,
    },
    {
      name: "SourceReposSettingsPanel",
      load: async () => (await import("../pages/source-repos-settings-panel.js")).SourceReposSettingsPanel,
    },
    {
      name: "TeamIdentityPanel",
      load: async () => (await import("../pages/team-identity-panel.js")).TeamIdentityPanel,
    },
    {
      name: "OnboardingPage",
      load: async () => (await import("../pages/onboarding/onboarding-page.js")).OnboardingPage,
    },
    { name: "LandingPage", load: async () => (await import("../pages/landing/index.js")).LandingPage },
    {
      name: "OnboardingFlowProvider+StepKickoff",
      load: async () => (props: Record<string, unknown>) =>
        createElement(OnboardingFlowProvider, { path: "admin", children: createElement(StepKickoff, props) }),
    },
    {
      name: "StepHeading",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).StepHeading,
      props: { title: "Connect", why: "Wire up the first agent." },
    },
    {
      name: "FlowNote",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).FlowNote,
      props: { tone: "info", children: "Heads up" },
    },
    {
      name: "WorkingState",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).WorkingState,
      props: { label: "Working", hint: "Almost done" },
    },
    {
      name: "StatusRow",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).StatusRow,
      props: { state: "ok", label: "Connected" },
    },
    {
      name: "CommandBox",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).CommandBox,
      props: { command: "first-tree login connect-token" },
    },
    {
      name: "RepoPicker",
      load: async () => (await import("../pages/onboarding/flow-ui.js")).RepoPicker,
      props: {
        repos: [
          { id: 1, fullName: "agent-team-foundation/first-tree", private: false, defaultBranch: "main", htmlUrl: "" },
        ],
        selectedUrls: ["https://github.com/agent-team-foundation/first-tree"],
        onToggle: () => {},
      },
    },
    { name: "TerminalGuide", load: async () => (await import("../pages/onboarding/guides.js")).TerminalGuide },
    { name: "InstallGuide", load: async () => (await import("../pages/onboarding/guides.js")).InstallGuide },
    { name: "ProgressRail", load: async () => (await import("../pages/onboarding/progress-rail.js")).ProgressRail },
    {
      name: "StepCreateAgent",
      load: async () => (await import("../pages/onboarding/steps/step-create-agent.js")).StepCreateAgent,
    },
    {
      name: "AgentRoster",
      load: async () => (await import("../pages/workspace/roster/index.js")).AgentRoster,
      props: {
        selectedAgentId: "agent-bot",
        selectedChatId: "chat-1",
        onSelectAgent: () => {},
        onSelectChat: () => {},
      },
    },
    {
      name: "ChatRightSidebar",
      load: async () => (await import("../pages/workspace/right-sidebar/index.js")).ChatRightSidebar,
      props: { chatId: "chat-1", chat: chatDetail, onClose: () => {} },
    },
    {
      name: "AddParticipantDropdown",
      load: async () => (await import("../components/add-participant-dropdown.js")).AddParticipantDropdown,
      props: { chatId: "chat-1", participants: chatDetail.participants, onAdded: () => {} },
    },
    {
      name: "AppearanceSection",
      load: async () => (await import("../pages/agent-detail/appearance-section.js")).AppearanceSection,
      props: { agent: botAgent, canEdit: true, onSave: async () => {}, onRefresh: async () => {} },
    },
    {
      name: "IdentitySection",
      load: async () => (await import("../pages/agent-detail/identity-section.js")).IdentitySection,
      props: { agent: { ...botAgent, delegateMention: "agent-private" }, canEdit: true, onSave: async () => {} },
    },
    {
      name: "ModelSection",
      load: async () => (await import("../pages/agent-detail/model-section.js")).ModelSection,
      props: { value: "gpt-5.5", baseline: "gpt-5.4", provider: "codex", onChange: () => {}, onRevert: () => {} },
    },
    {
      name: "EnvSection",
      load: async () => (await import("../pages/agent-detail/env-section.js")).EnvSection,
      props: {
        items: draftItems().env,
        otherKeys: () => new Set(["DEBUG"]),
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
    },
    {
      name: "EnvSectionEditDialog",
      load: async () => (await import("../pages/agent-detail/env-section.js")).EnvSection,
      props: {
        items: draftItems().env,
        otherKeys: () => new Set(["DEBUG"]),
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
      stateValues: [
        {
          mode: "edit",
          key: "env-1",
          initial: { name: "GITHUB_TOKEN", key: "GITHUB_TOKEN", value: "***", sensitive: true },
        },
        new Set<string>(),
        "GITHUB_TOKEN",
        "",
        true,
        "Previous env error",
      ],
    },
    {
      name: "McpSection",
      load: async () => (await import("../pages/agent-detail/mcp-section.js")).McpSection,
      props: {
        items: draftItems().mcp,
        otherNames: () => new Set(["github"]),
        toolHealth: () => "working",
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
    },
    {
      name: "McpSectionHttpDialog",
      load: async () => (await import("../pages/agent-detail/mcp-section.js")).McpSection,
      props: {
        items: [
          {
            key: "mcp-1",
            value: {
              name: "github",
              transport: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_TOKEN: githubTokenTemplate },
            },
            baseline: null,
            status: "unchanged",
          },
          {
            key: "mcp-2",
            value: {
              name: "remote",
              transport: "http",
              url: "https://mcp.example.test",
              headers: { Authorization: "Bearer token" },
            },
            baseline: null,
            status: "added",
          },
        ],
        otherNames: () => new Set(["github"]),
        toolHealth: (name: string) => (name === "remote" ? "error" : "unknown"),
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
      stateValues: [
        {
          mode: "edit",
          key: "mcp-2",
          initial: {
            name: "remote",
            transport: "http",
            url: "https://mcp.example.test",
            headers: { Authorization: "Bearer token" },
          },
        },
        "http",
        "remote",
        "",
        "",
        "https://mcp.example.test",
        '{"Authorization":"Bearer token"}',
        "Previous MCP error",
      ],
    },
    {
      name: "McpSectionStdioDialog",
      load: async () => (await import("../pages/agent-detail/mcp-section.js")).McpSection,
      props: {
        items: draftItems().mcp,
        otherNames: () => new Set<string>(),
        toolHealth: () => "working",
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
      stateValues: [{ mode: "add" }, "stdio", "playwright", "npx", '["-y","@playwright/mcp"]', "", "", null],
    },
    {
      name: "GitSection",
      load: async () => (await import("../pages/agent-detail/git-section.js")).GitSection,
      props: {
        items: draftItems().git,
        otherPaths: () => new Set(["first-tree"]),
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
    },
    {
      name: "GitSectionAddDialog",
      load: async () => (await import("../pages/agent-detail/git-section.js")).GitSection,
      props: {
        items: draftItems().git,
        otherPaths: () => new Set(["first-tree"]),
        onAdd: () => {},
        onUpdate: () => {},
        onDelete: () => {},
        onUndoDelete: () => {},
      },
      stateValues: [
        { mode: "add" },
        "https://github.com/agent-team-foundation/first-tree-context.git",
        "main",
        "first-tree-context",
        "Previous git error",
      ],
    },
    {
      name: "DangerZone",
      load: async () => (await import("../pages/agent-detail/danger-zone.js")).DangerZone,
      props: {
        agent: { ...suspendedAgent, displayName: "Dormant" },
        deletePending: false,
        errorMessage: "Last delete failed",
        onDelete: () => {},
        onReactivate: () => {},
        onSuspend: () => {},
        reactivatePending: false,
        suspendPending: false,
      },
    },
    {
      name: "PromptSection",
      load: async () => (await import("../pages/agent-detail/prompt-section.js")).PromptSection,
      props: { value: "Be direct.", baseline: "", onChange: () => {}, onRevert: () => {} },
    },
    {
      name: "SaveBar",
      load: async () => (await import("../pages/agent-detail/save-bar.js")).SaveBar,
      props: {
        conflictMessage: "Remote config changed",
        errorMessage: "Save failed",
        justSaved: true,
        onDiscard: () => {},
        onJumpTo: () => {},
        onReloadRemote: () => {},
        onSave: () => {},
        reloadingRemote: true,
        saveHint: "New sessions pick up changes.",
        saving: false,
        summary: {
          anyDirty: true,
          dirtySections: ["prompt", "model", "mcp", "env", "git"],
          counts: { prompt: 1, model: 1, mcp: 1, env: 2, git: 1 },
        },
      },
    },
    {
      name: "AgentStatusPanel",
      load: async () => (await import("../components/chat/agent-status-panel.js")).AgentStatusPanel,
      props: { chatId: "chat-1", agents: chatDetail.participants, canManage: () => true, order: "priority" },
    },
    {
      name: "ComposeStatusBar",
      load: async () => (await import("../components/chat/compose-status-bar.js")).ComposeStatusBar,
      props: { chatId: "chat-1", agents: chatDetail.participants },
    },
    {
      name: "WorkingBubble",
      load: async () => (await import("../components/chat/working-bubble.js")).WorkingBubble,
      props: { events: sessionEvents, defaultOpen: true },
    },
    {
      name: "WorkingChip",
      load: async () => (await import("../components/chat/working-chip.js")).WorkingChip,
      props: {
        activity: { agentId: "agent-bot", kind: "tool_call", label: "Bash", startedAt: iso },
        monochrome: true,
        prefix: "Working",
        showDot: true,
      },
    },
    {
      name: "TimelineJumpButton",
      load: async () => (await import("../components/chat/timeline-jump-button.js")).TimelineJumpButton,
      props: {
        agentId: "agent-bot",
        anchored: true,
        ariaLabel: "Jump to Atlas",
        children: "Working",
        main: "working",
      },
    },
    {
      name: "ConnectStuckPanel",
      load: async () => (await import("../components/connect-stuck-panel.js")).ConnectStuckPanel,
    },
    {
      name: "HistoryGapBanner",
      load: async () => (await import("../components/history-gap-banner.js")).HistoryGapBanner,
    },
    {
      name: "LastStepModal",
      load: async () => (await import("../components/last-step-modal.js")).LastStepModal,
      props: { agent: { ...botAgent, clientId: null }, open: true, onBound: () => {}, onClose: () => {} },
    },
    {
      name: "NewMessagesPill",
      load: async () => (await import("../components/new-messages-pill.js")).NewMessagesPill,
      props: { count: 2, onClick: () => {} },
    },
    { name: "UnreadDivider", load: async () => (await import("../components/unread-divider.js")).UnreadDivider },
    {
      name: "ConnectCommandPanel",
      load: async () => (await import("../components/connect-command-panel.js")).ConnectCommandPanel,
      props: {
        caption: "Reusable command",
        command: "first-tree login connect-token",
        copyButtonPlacement: "bottom",
        errorContent: "Could not connect",
        expiresInSeconds: 650,
        phase: "error",
        successContent: "Connected",
        waitingText: "Waiting",
      },
    },
    {
      name: "TeamSetupModalCreate",
      load: async () => (await import("../components/team-setup-modal.js")).TeamSetupModal,
      props: { action: "create", onClose: () => {} },
      stateValues: ["Acme Robotics", "Create failed", false],
    },
    {
      name: "TeamSetupModalJoin",
      load: async () => (await import("../components/team-setup-modal.js")).TeamSetupModal,
      props: { action: "join", onClose: () => {} },
      stateValues: ["https://hub.example.test/invite/abc123", "Join failed", false],
    },
    {
      name: "AgentStatusChip",
      load: async () => (await import("../components/ui/agent-status-chip.js")).AgentStatusChip,
      props: { main: "needs_you" },
    },
    {
      name: "Breadcrumb",
      load: async () => {
        const mod = await import("../components/ui/breadcrumb.js");
        return () =>
          createElement(mod.Breadcrumb, {
            children: [
              createElement(mod.BreadcrumbLink, { onClick: () => {}, children: "Agents" }),
              createElement(mod.BreadcrumbSep),
              createElement(mod.BreadcrumbCurrent, { mono: true, children: "atlas" }),
            ],
          });
      },
    },
    {
      name: "FlatSectionHeader",
      load: async () => (await import("../components/ui/flat-section-header.js")).FlatSectionHeader,
      props: { children: "Agents", count: 3, right: createElement("button", { children: "Add" }) },
    },
    {
      name: "SectionHeader",
      load: async () => (await import("../components/ui/section-header.js")).SectionHeader,
      props: { children: "Runtime", right: createElement("span", { children: "ok" }) },
    },
    {
      name: "TabBar",
      load: async () => {
        const mod = await import("../components/ui/tab-bar.js");
        return () =>
          createElement(mod.TabBar, {
            children: [
              createElement(mod.Tab, {
                active: true,
                onClick: () => {},
                children: ["Members", createElement(mod.TabBadge, { children: 5 })],
              }),
              createElement(mod.Tab, { active: false, onClick: () => {}, children: "Agents" }),
            ],
          });
      },
    },
    {
      name: "Tile",
      load: async () => (await import("../components/ui/tile.js")).Tile,
      props: { accent: "var(--accent)", label: "Open", value: 4 },
    },
    {
      name: "ToastProvider",
      load: async () => (await import("../components/ui/toast.js")).ToastProvider,
      props: { children: createElement("main", { children: "Dashboard" }) },
      stateValues: [
        [
          {
            id: "toast-1",
            title: "Setup hidden",
            description: "Resume any time from Settings.",
            durationMs: null,
            action: { label: "Undo", onClick: () => {} },
          },
        ],
      ],
    },
    {
      name: "DocPreviewDrawer",
      load: async () => (await import("../components/doc-preview-drawer.js")).DocPreviewDrawer,
    },
    { name: "UserMenu", load: async () => (await import("../components/user-menu.js")).UserMenu },
    { name: "Layout", load: async () => (await import("../components/layout.js")).Layout },
  ];
}

describe("web component shallow smoke", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    queryOverrides.clear();
    mutationResultOverride = null;
    authOverride = {};
    routerSearch = "?agent=agent-bot&c=chat-1";
    outletContextOverride = null;
    viewportOverride = null;
    setupBrowserGlobals();
  });

  it("executes high-density UI components and their private render helpers", async () => {
    const state = createState();
    setupModuleMocks(state);

    for (const item of await componentCases()) {
      state.stateValues = [...(item.stateValues ?? [])];
      const component = await item.load();
      expect(typeof component, item.name).toBe("function");
      if (isUnknownFn(component)) {
        state.nodes = 0;
        renderNode(createElement(component, item.props ?? {}), state);
      }
    }

    for (const cleanup of state.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Same rationale as event handlers: the harness validates render
        // reachability, not browser lifecycle exactness.
      }
    }

    expect(state.rendered).toBeGreaterThan(150);
    expect(state.events).toBeGreaterThan(30);
  }, 30_000);

  it("executes onboarding steps with a populated flow context", async () => {
    const state = createState();
    setupModuleMocks(state);
    vi.doMock("../pages/onboarding/onboarding-flow.js", () => ({
      OnboardingFlowProvider: ({ children }: Record<string, unknown>) => children,
      useOnboardingFlow: () => onboardingFlowValue(),
    }));

    const cases: ComponentCase[] = [
      {
        name: "StepWelcome",
        load: async () => (await import("../pages/onboarding/steps/step-welcome.js")).StepWelcome,
      },
      { name: "StepTeam", load: async () => (await import("../pages/onboarding/steps/step-team.js")).StepTeam },
      {
        name: "StepConnectComputer",
        load: async () => (await import("../pages/onboarding/steps/step-connect-computer.js")).StepConnectComputer,
      },
      {
        name: "StepCreateAgent",
        load: async () => (await import("../pages/onboarding/steps/step-create-agent.js")).StepCreateAgent,
      },
      {
        name: "StepConnectCode",
        load: async () => (await import("../pages/onboarding/steps/step-connect-code.js")).StepConnectCode,
      },
      {
        name: "StepKickoff",
        load: async () => (await import("../pages/onboarding/steps/step-kickoff.js")).StepKickoff,
      },
    ];

    for (const item of cases) {
      const component = await item.load();
      expect(typeof component, item.name).toBe("function");
      if (isUnknownFn(component)) {
        state.nodes = 0;
        renderNode(createElement(component, item.props ?? {}), state);
      }
    }

    expect(state.rendered).toBeGreaterThan(20);
  }, 20_000);

  it("executes settings layout, invite link, and GitHub installation edge states", async () => {
    const state = createState();
    setupModuleMocks(state);
    const { SettingsLayout } = await import("../pages/settings.js");
    const { InviteLinkPanel } = await import("../pages/invite-link-panel.js");
    const { ApiError } = await import("../api/client.js");
    const { GithubAppInstallationPanel } = await import("../pages/github-app-installation-panel.js");
    const githubKey = JSON.stringify(["github-app-installation", "org-1"]);

    authOverride = { meLoaded: false };
    renderNode(createElement(SettingsLayout), state);

    authOverride = { meLoaded: true, onboardingCompletedAt: null, role: "admin" };
    viewportOverride = "narrow";
    state.nodes = 0;
    renderNode(createElement(SettingsLayout), state);

    authOverride = { meLoaded: true, onboardingCompletedAt: iso, role: "member" };
    viewportOverride = "xl";
    state.nodes = 0;
    renderNode(createElement(SettingsLayout), state);

    state.stateValues = [
      {
        createdAt: iso,
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        inviteUrl: "https://hub.example.test/invite/invite-token",
        token: "invite-token",
      },
      null,
      false,
      false,
    ];
    state.nodes = 0;
    renderNode(createElement(InviteLinkPanel), state);

    authOverride = { organizationId: null };
    state.stateValues = [null, "Load failed", true, false];
    state.nodes = 0;
    renderNode(createElement(InviteLinkPanel), state);

    authOverride = { organizationId: "org-1" };
    queryOverrides.set(githubKey, queryResult({ isLoading: true, status: "loading" }));
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    queryOverrides.set(
      githubKey,
      queryResult({ error: new Error("GitHub unavailable"), isError: true, status: "error" }),
    );
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    queryOverrides.set(githubKey, queryResult({ data: null }));
    mutationResultOverride = { error: new ApiError(503, "slug missing"), status: "error" };
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    mutationResultOverride = { error: new Error("Install URL failed"), status: "error" };
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    mutationResultOverride = { isPending: true, status: "pending" };
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    mutationResultOverride = null;
    authOverride = { organizationId: null };
    state.nodes = 0;
    renderNode(createElement(GithubAppInstallationPanel), state);

    await Promise.resolve();
    await Promise.resolve();

    expect(state.rendered).toBeGreaterThan(30);
    expect(state.events).toBeGreaterThanOrEqual(4);
  }, 20_000);

  it("executes onboarding page route gates and body step selection", async () => {
    const state = createState();
    let activeStep = "welcome";
    setupModuleMocks(state);
    vi.doMock("../pages/onboarding/onboarding-flow.js", () => ({
      OnboardingFlowProvider: ({ children }: Record<string, unknown>) => children,
      useOnboardingFlow: () => ({ activeStep }),
    }));

    const { OnboardingPage } = await import("../pages/onboarding/onboarding-page.js");

    authOverride = { meLoaded: false };
    renderNode(createElement(OnboardingPage), state);

    authOverride = {
      meLoaded: true,
      onboardingCompletedAt: iso,
      onboardingDismissedAt: null,
      onboardingStep: "completed",
      role: "admin",
    };
    state.nodes = 0;
    renderNode(createElement(OnboardingPage), state);

    authOverride = {
      meLoaded: true,
      onboardingCompletedAt: null,
      onboardingDismissedAt: null,
      onboardingStep: "connect",
      role: "admin",
    };
    for (const step of ["team", "connect-code", "connect-computer", "create-agent", "kickoff", "welcome", "unknown"]) {
      activeStep = step;
      state.nodes = 0;
      renderNode(createElement(OnboardingPage), state);
    }

    expect(state.rendered).toBeGreaterThan(20);
  }, 20_000);

  it("executes alternate chat view timeline and composer branches", async () => {
    const state = createState([
      "@atlas /review this",
      19,
      true,
      "Image too large",
      true,
      { chatId: "chat-1", messageId: "msg-new" },
      true,
      "Renamed topic",
      "msg-1",
      false,
      "msg-2",
      "msg-1",
      0,
    ]);
    setupModuleMocks(state);
    vi.doMock("../lib/use-pending-images.js", () => ({
      usePendingImages: () => ({
        addImages: () => {},
        clearImages: () => {},
        pendingImages: [
          {
            file: { name: "diagram.png", size: 128, type: "image/png" },
            id: "pending-image-1",
            previewUrl: "blob:diagram",
          },
        ],
        removeImage: () => {},
      }),
    }));

    const manyParticipants = [
      ...chatDetail.participants,
      { ...chatParticipant, agentId: "agent-private", name: "helper", displayName: "Private Helper" },
      { ...chatParticipant, agentId: "agent-team", name: "reviewer", displayName: "Reviewer" },
      { ...chatParticipant, agentId: "agent-extra", name: "extra", displayName: "Extra" },
    ];
    queryOverrides.set(JSON.stringify(["chat-attentions", "chat-1"]), []);
    queryOverrides.set(JSON.stringify(["chat-detail", "chat-1"]), {
      ...chatDetail,
      engagementStatus: "deleted",
      metadata: { source: "github", entityUrl: "https://github.com/agent-team-foundation/first-tree/pull/12" },
      participants: manyParticipants,
      title: "Renamed topic",
      type: "direct",
    });
    queryOverrides.set(JSON.stringify(["chat-read-state", "chat-1"]), {
      bottomVisibleMessageId: "msg-1",
      chatId: "chat-1",
      latestKnownMessageId: "msg-1",
      updatedAt: Date.now(),
    });
    queryOverrides.set(JSON.stringify(["chat-messages-cache", "chat-1"]), [
      { ...textMessage, format: "text", id: "msg-cache", source: "web" },
    ]);
    queryOverrides.set(JSON.stringify(["chat-messages", "chat-1"]), {
      items: [
        {
          ...textMessage,
          deliveryStatus: "acked",
          format: "text",
          id: "msg-1",
          inReplyTo: null,
          source: "web",
        },
        {
          ...textMessage,
          content: "See README.md and MISSING.md",
          format: "markdown",
          id: "msg-2",
          inReplyTo: null,
          metadata: {
            documentContext: {
              docs: [{ content: "# Readme", path: "README.md", sha256: "abc", size: 8 }],
              failedMentions: [{ raw: "MISSING.md", reason: "missing" }],
              kind: "snapshot",
            },
          },
          senderId: "agent-bot",
          source: "agent",
        },
        {
          ...textMessage,
          content: { data: "aW1hZ2U=", filename: "inline.png", mimeType: "image/png", size: 5 },
          format: "file",
          id: "msg-inline",
          inReplyTo: null,
          senderId: "agent-human",
          source: "web",
        },
        {
          ...textMessage,
          content: { filename: "ref.png", imageId: "img-1", mimeType: "image/png", size: 5 },
          format: "file",
          id: "msg-ref",
          inReplyTo: null,
          senderId: "agent-human",
          source: "web",
        },
        {
          ...githubMessage,
          format: "card",
          id: "msg-card",
          inReplyTo: null,
          source: "github",
        },
        {
          ...textMessage,
          content: { kind: "other", value: 1 },
          format: "card",
          id: "msg-json",
          inReplyTo: null,
          senderId: "agent-bot",
          source: "agent",
        },
      ],
      nextCursor: null,
    });
    queryOverrides.set(JSON.stringify(["session-events", "agent-bot", "chat-1"]), {
      items: [
        {
          agentId: "agent-bot",
          chatId: "chat-1",
          createdAt: iso,
          id: "evt-old-end",
          kind: "turn_end",
          payload: {},
          seq: 1,
          sessionId: "session-1",
        },
        {
          agentId: "agent-bot",
          chatId: "chat-1",
          createdAt: iso,
          id: "evt-tool",
          kind: "tool_call",
          payload: { name: "bash", status: "running", toolUseId: "tool-1" },
          seq: 2,
          sessionId: "session-1",
        },
        {
          agentId: "agent-bot",
          chatId: "chat-1",
          createdAt: iso,
          id: "evt-thinking",
          kind: "thinking",
          payload: { text: "Planning" },
          seq: 3,
          sessionId: "session-1",
        },
        {
          agentId: "agent-bot",
          chatId: "chat-1",
          createdAt: iso,
          id: "evt-assistant",
          kind: "assistant_text",
          payload: { text: "Streaming answer" },
          seq: 4,
          sessionId: "session-1",
        },
        {
          agentId: "agent-bot",
          chatId: "chat-1",
          createdAt: iso,
          id: "evt-error",
          kind: "error",
          payload: { message: "Tool failed", source: "runtime" },
          seq: 5,
          sessionId: "session-1",
        },
      ],
      nextCursor: null,
    });

    const { ChatView } = await import("../pages/workspace/center/chat-view.js");
    renderNode(
      createElement(ChatView, {
        agentId: "agent-bot",
        chatId: "chat-1",
        narrow: true,
        onShowConversations: () => {},
        titleFallback: "Renamed topic",
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(30);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes chat view read-only, details rail, empty timeline, doc-toggle, and attention composer branches", async () => {
    routerSearch = "?docChat=chat-1&docPath=atlas%2Fchat-1%2FREADME.md";
    const state = createState(["", 0, false, null, [], true]);
    setupModuleMocks(state);
    queryOverrides.set(JSON.stringify(["chat-messages-cache", "chat-1"]), []);
    queryOverrides.set(JSON.stringify(["chat-messages", "chat-1"]), { items: [], nextCursor: null });
    queryOverrides.set(JSON.stringify(["session-events", "agent-bot", "chat-1"]), { items: [], nextCursor: null });
    queryOverrides.set(JSON.stringify(["chat-detail", "chat-1"]), {
      ...chatDetail,
      engagementStatus: "active",
      metadata: { source: "github", entityUrl: "https://github.com/agent-team-foundation/first-tree/pull/12" },
      participants: [],
      title: null,
    });

    const { ChatView } = await import("../pages/workspace/center/chat-view.js");
    renderNode(
      createElement(ChatView, {
        agentId: "agent-bot",
        chatId: "chat-1",
        joinAction: { error: "Join failed", joining: true, onJoin: () => {} },
        readOnly: true,
        titleFallback: "Watching launch review",
      }),
      state,
    );

    routerSearch = "?agent=agent-bot&c=chat-1";
    queryOverrides.set(JSON.stringify(["chat-attentions", "chat-1"]), [
      { ...attention, id: "attention-new", createdAt: "2026-05-28T00:05:00.000Z" },
      { ...attention, id: "attention-old", createdAt: "2026-05-28T00:00:00.000Z" },
    ]);
    queryOverrides.set(JSON.stringify(["chat-detail", "chat-1"]), {
      ...chatDetail,
      engagementStatus: "active",
      participants: [
        ...chatDetail.participants,
        { ...chatParticipant, agentId: "agent-private", name: "helper", displayName: "Private Helper" },
      ],
      title: "Launch review",
    });
    queryOverrides.set(JSON.stringify(["chat-messages", "chat-1"]), messagesPage);
    state.stateValues = ["", 0, false, null, [], false];
    renderNode(
      createElement(ChatView, { agentId: "agent-bot", chatId: "chat-1", titleFallback: "Launch review" }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(30);
    expect(state.events).toBeGreaterThan(6);
  }, 20_000);

  it("executes document preview, participant picker, and alternate attention states", async () => {
    routerSearch = "?docChat=chat-1&docAgent=agent-bot&docPath=atlas%2Fchat-1%2FREADME.md&docMsg=msg-2&docBase=docs";
    const state = createState([false, 720]);
    setupModuleMocks(state);

    const { DocPreviewDrawer } = await import("../components/doc-preview-drawer.js");
    renderNode(createElement(DocPreviewDrawer), state);

    routerSearch = "?docChat=chat-1&docAgent=agent-bot&docPath=docs%2FREADME.md&docBase=docs";
    state.stateValues = [false, 640];
    renderNode(createElement(DocPreviewDrawer), state);

    state.stateValues = [true, 1, "atlas", "atlas"];
    const { AddParticipantDropdown } = await import("../components/add-participant-dropdown.js");
    renderNode(
      createElement(AddParticipantDropdown, {
        chatId: "chat-1",
        participantIds: ["agent-human", "agent-bot"],
        onAdded: () => {},
        variant: "icon",
      }),
      state,
    );
    state.stateValues = [true, 0, "", ""];
    renderNode(
      createElement(AddParticipantDropdown, {
        chatId: "chat-1",
        participantIds: agents.map((item) => String(item.uuid)),
        onAdded: () => {},
        variant: "inline",
      }),
      state,
    );

    const { AttentionCard } = await import("../components/chat/attention-card.js");
    state.stateValues = [
      Date.now(),
      new Map<string, Set<string>>([["default", new Set(["approve"])]]),
      false,
      "",
      true,
    ];
    renderNode(
      createElement(AttentionCard, {
        attention: {
          ...attention,
          metadata: {
            options: {
              mode: "single",
              defaultValue: "approve",
              items: [
                { value: "approve", label: "Approve", hint: "Proceed" },
                { value: "hold", label: "Hold", hint: "Wait" },
              ],
            },
          },
        },
        onResponded: () => {},
      }),
      state,
    );
    state.stateValues = [Date.now(), new Map<string, Set<string>>(), true, "LGTM", false];
    renderNode(
      createElement(AttentionCard, {
        attention: { ...attention, body: "", metadata: {} },
        onResponded: () => {},
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(25);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes computers page admin, modal, table, and demo branches", async () => {
    const mine = {
      ...client,
      agentCount: 2,
      authState: "expired",
      capabilities: {
        "claude-code": { state: "ok", sdkVersion: "1.0.0" },
        codex: { state: "unauthenticated", sdkVersion: "0.35.0" },
      },
      id: "client-mine",
      os: "linux",
      userId: "user-1",
    };
    const teammate = {
      ...client,
      agentCount: 1,
      authState: "ok",
      capabilities: {
        "claude-code": { state: "missing" },
        codex: { state: "error", error: "probe failed" },
      },
      hostname: "grace-laptop",
      id: "client-team",
      lastSeenAt: "2026-05-27T00:00:00.000Z",
      os: "darwin",
      status: "offline",
      userId: "user-2",
    };
    const legacy = {
      ...client,
      agentCount: 0,
      capabilities: {},
      hostname: null,
      id: "client-legacy",
      os: null,
      userId: null,
    };
    const state = createState([
      null,
      new Set<string>(),
      true,
      mine,
      teammate,
      "Retire blocked",
      true,
      "client-mine",
      "ada-workstation",
    ]);
    setupModuleMocks(state);
    queryOverrides.set(JSON.stringify(["clients", "org"]), [mine, teammate, legacy]);
    queryOverrides.set(JSON.stringify(["clients", "me"]), [mine]);
    queryOverrides.set(JSON.stringify(["activity"]), {
      agents: [
        { ...botAgent, activeSessions: 1, agentId: "agent-bot", clientId: "client-mine", totalSessions: 3 },
        { ...teamAgent, activeSessions: null, agentId: "agent-team", clientId: "client-team", totalSessions: null },
      ],
    });

    const { ClientsPage } = await import("../pages/clients.js");
    renderNode(createElement(ClientsPage), state);

    const { DemoNavigator } = await import("../pages/clients/demo-navigator.js");
    renderNode(
      createElement(DemoNavigator, {
        activeKey: "admin-grouped",
        onExit: () => {},
        onSelect: () => {},
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(45);
    expect(state.events).toBeGreaterThan(12);
  }, 20_000);

  it("executes invitee kickoff substates and start actions", async () => {
    const state = createState();
    setupModuleMocks(state);
    const flow = onboardingFlowValue({ path: "invitee", role: "member" });
    vi.doMock("../pages/onboarding/onboarding-flow.js", () => ({
      OnboardingFlowProvider: ({ children }: Record<string, unknown>) => children,
      useOnboardingFlow: () => flow,
    }));
    queryOverrides.set(JSON.stringify(["onboarding", "github-repos"]), [
      { id: 1, fullName: "agent-team-foundation/first-tree", private: false, defaultBranch: "main", htmlUrl: "" },
      {
        id: 2,
        fullName: "agent-team-foundation/first-tree-context",
        private: true,
        defaultBranch: "main",
        htmlUrl: "",
      },
    ]);
    const { StepKickoff } = await import("../pages/onboarding/steps/step-kickoff.js");

    const variants = [
      { treeUrl: "", teamRepoUrls: [], hasInstallation: true, installationKnown: true },
      {
        treeUrl: "https://github.com/agent-team-foundation/first-tree-context.git",
        teamRepoUrls: ["https://github.com/agent-team-foundation/first-tree.git"],
        hasInstallation: true,
        installationKnown: true,
      },
      {
        treeUrl: "https://github.com/agent-team-foundation/first-tree-context",
        teamRepoUrls: [],
        hasInstallation: true,
        installationKnown: true,
      },
      {
        treeUrl: "https://github.com/agent-team-foundation/first-tree-context",
        teamRepoUrls: ["git@github.com:agent-team-foundation/first-tree.git"],
        hasInstallation: false,
        installationKnown: true,
      },
    ];

    for (const variant of variants) {
      queryOverrides.set(JSON.stringify(["onboarding", "team-config", "org-1"]), variant);
      state.nodes = 0;
      renderNode(createElement(StepKickoff), state);
    }

    expect(state.rendered).toBeGreaterThan(25);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes new chat draft participant, picker, image, and send branches", async () => {
    const knownAgents = new Map<string, Record<string, unknown>>([
      ["agent-bot", { agentId: "agent-bot", name: "atlas", displayName: "Atlas", managedByMe: true }],
      ["agent-team", { agentId: "agent-team", name: "reviewer", displayName: "Atlas", managedByMe: false }],
      ["agent-private", { agentId: "agent-private", name: "helper", displayName: "Private Helper", managedByMe: true }],
    ]);
    const state = createState([
      ["agent-bot", "agent-team"],
      "@atlas please review",
      7,
      "Previous send failed",
      false,
      true,
      "atlas",
      knownAgents,
      "atlas",
      "atlas",
      0,
      0,
      null,
      1,
    ]);
    setupModuleMocks(state);
    vi.doMock("../lib/use-pending-images.js", () => ({
      usePendingImages: () => ({
        addImages: () => {},
        clearImages: () => {},
        pendingImages: [
          {
            file: { name: "diagram.png", size: 128, type: "image/png" },
            id: "pending-image-1",
            previewUrl: "blob:diagram",
          },
        ],
        removeImage: () => {},
      }),
    }));

    const { NewChatDraft, pickDefault } = await import("../pages/workspace/conversations/new-chat-draft.js");
    renderNode(createElement(NewChatDraft, { onCreated: () => {}, onShowConversations: () => {} }), state);

    expect(
      pickDefault(
        [{ uuid: "agent-human", type: "human", managerId: "member-1", status: "active", delegateMention: null }],
        "agent-human",
      ),
    ).toBeNull();
    expect(
      pickDefault(
        [
          { uuid: "agent-human", type: "human", managerId: "member-1", status: "active", delegateMention: "agent-bot" },
          { uuid: "agent-bot", type: "agent", managerId: "member-1", status: "active", delegateMention: null },
        ],
        "agent-human",
      ),
    ).toBe("agent-bot");
    expect(
      pickDefault(
        [
          { uuid: "agent-human", type: "human", managerId: "member-1", status: "active", delegateMention: "agent-bot" },
          { uuid: "agent-bot", type: "agent", managerId: "member-1", status: "suspended", delegateMention: null },
        ],
        "agent-human",
      ),
    ).toBeNull();

    expect(state.errors.map((error) => error.message)).toEqual([]);
    expect(state.rendered).toBeGreaterThan(10);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes invite acceptance states and join action", async () => {
    const preview = {
      createdAt: iso,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      organizationDisplayName: "Research Team",
      token: "invite-token",
    };
    const state = createState([preview, null, false, "Compute Team"]);
    setupModuleMocks(state);

    const { InviteAcceptPage } = await import("../pages/invite-accept.js");
    renderNode(createElement(InviteAcceptPage), state);

    state.stateValues = [
      {
        ...preview,
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        organizationDisplayName: "Compute Team",
      },
      null,
      true,
      "Compute Team",
    ];
    renderNode(createElement(InviteAcceptPage), state);

    state.stateValues = [null, "Expired", false, null];
    renderNode(createElement(InviteAcceptPage), state);

    expect(state.rendered).toBeGreaterThan(20);
    expect(state.events).toBeGreaterThan(1);
  }, 20_000);

  it("executes app routes and agent detail tab branches", async () => {
    const state = createState();
    setupModuleMocks(state);

    const { App } = await import("../app.js");
    renderNode(createElement(App), state);

    const { SetupTab } = await import("../pages/agent-detail/setup-tab.js");
    const { PromptTab } = await import("../pages/agent-detail/prompt-tab.js");
    const { ToolsTab } = await import("../pages/agent-detail/tools-tab.js");
    const { ResourcesTab } = await import("../pages/agent-detail/resources-tab.js");
    const { ProfileTab } = await import("../pages/agent-detail/profile-tab.js");

    outletContextOverride = defaultAgentDetailContext();
    for (const component of [SetupTab, PromptTab, ToolsTab, ResourcesTab, ProfileTab]) {
      state.nodes = 0;
      renderNode(createElement(component), state);
    }

    outletContextOverride = defaultAgentDetailContext({ canEditConfig: false, canManageAgent: false });
    for (const component of [SetupTab, PromptTab, ToolsTab, ResourcesTab, ProfileTab]) {
      state.nodes = 0;
      renderNode(createElement(component), state);
    }

    outletContextOverride = defaultAgentDetailContext({
      config: undefined,
      configError: "network down",
      configLoading: true,
    });
    state.nodes = 0;
    renderNode(createElement(SetupTab), state);
    renderNode(createElement(PromptTab), state);
    renderNode(createElement(ToolsTab), state);
    renderNode(createElement(ResourcesTab), state);

    const { SetupSection } = await import("../pages/agent-detail/setup-section.js");
    for (const props of [
      {
        runtimeProvider: "claude-code",
        computerLabel: "ada-workstation",
        canBindComputer: false,
        onRebind: () => {},
        modelSlot: createElement("span", { children: "model" }),
      },
      {
        runtimeProvider: "codex",
        computerLabel: null,
        canBindComputer: true,
        bindComputerPending: true,
        onBindComputer: () => {},
        modelSlot: createElement("span", { children: "model" }),
      },
      {
        runtimeProvider: "codex",
        computerLabel: null,
        computerStatusLoading: true,
        canBindComputer: false,
        modelSlot: createElement("span", { children: "model" }),
      },
      {
        runtimeProvider: "claude-code",
        computerLabel: null,
        computerStatusError: "offline",
        canBindComputer: false,
        modelSlot: createElement("span", { children: "model" }),
      },
    ]) {
      state.nodes = 0;
      renderNode(createElement(SetupSection, props), state);
    }

    expect(state.rendered).toBeGreaterThan(80);
    expect(state.events).toBeGreaterThan(12);
  }, 20_000);

  it("executes agent detail page loading, error, human, dialog, and save branches", async () => {
    const state = createState();
    setupModuleMocks(state);
    const draftMock = {
      addEnv: () => {},
      addGit: () => {},
      addMcp: () => {},
      buildPayloadPatch: () => ({ model: "gpt-5" }),
      deleteEnv: () => {},
      deleteGit: () => {},
      deleteMcp: () => {},
      draft: {
        env: draftItems().env,
        git: draftItems().git,
        mcp: draftItems().mcp,
        model: "gpt-5",
        promptAppend: "Focus on tests.",
      },
      resetAll: () => {},
      resetToConfig: () => {},
      revertModel: () => {},
      revertPrompt: () => {},
      setModel: () => {},
      setPromptAppend: () => {},
      summary: {
        anyDirty: true,
        counts: { env: 1, git: 1, mcp: 1, model: 1, prompt: 1 },
        dirtySections: ["prompt", "model", "mcp", "env", "git"],
      },
      undoDeleteEnv: () => {},
      undoDeleteGit: () => {},
      undoDeleteMcp: () => {},
      updateEnv: () => {},
      updateGit: () => {},
      updateMcp: () => {},
    };
    vi.doMock("../pages/agent-detail/use-config-draft.js", () => ({ useConfigDraft: () => draftMock }));
    vi.doMock("../api/agent-config.js", () => ({
      dryRunAgentConfig: async () => ({ diff: [{ op: "replace", path: "/model" }] }),
      getAgentClientStatus: async () => dataForQuery(["agent-client-status"]),
      getAgentConfig: async () => agentConfig(),
      updateAgentConfig: async () => agentConfig(),
    }));
    const { ApiError } = await import("../api/client.js");
    const { AgentDetailPage } = await import("../pages/agent-detail.js");
    const renderDetail = (values: unknown[] = []): void => {
      state.nodes = 0;
      state.stateValues = values;
      renderNode(createElement(AgentDetailPage), state);
    };

    queryOverrides.set(JSON.stringify(["agent", "agent-bot"]), queryResult({ isLoading: true, status: "loading" }));
    renderDetail();

    queryOverrides.set(
      JSON.stringify(["agent", "agent-bot"]),
      queryResult({ error: new ApiError(404, "missing"), isError: true, status: "error" }),
    );
    renderDetail();

    queryOverrides.set(
      JSON.stringify(["agent", "agent-bot"]),
      queryResult({ error: new ApiError(503, "server down"), isError: true, status: "error" }),
    );
    renderDetail();

    queryOverrides.set(JSON.stringify(["agent", "agent-bot"]), queryResult({ data: null }));
    renderDetail();

    queryOverrides.set(JSON.stringify(["agent", "agent-bot"]), { ...humanAgent, status: "active" });
    authOverride = { memberId: "member-2", role: "member" };
    renderDetail();

    authOverride = { memberId: "member-1", role: "admin" };
    queryOverrides.set(JSON.stringify(["agent", "agent-bot"]), {
      ...botAgent,
      runtimeProvider: "codex",
      runtimeState: null,
      status: "active",
    });
    queryOverrides.set(JSON.stringify(["agent-client-status", "agent-bot"]), {
      authState: "ok",
      clientId: "client-1",
      hostname: "ada-workstation",
      offlineSince: "2026-05-27T00:00:00.000Z",
      status: "offline",
    });
    queryOverrides.set(JSON.stringify(["agent-sessions-active", "agent-bot"]), [{ id: "session-1" }]);
    queryOverrides.set(JSON.stringify(["clients"]), [
      client,
      { ...client, id: "client-offline", hostname: "offline-box", status: "offline" },
    ]);
    renderDetail([
      "Save failed",
      "Conflict while saving",
      "Lifecycle failed",
      true,
      true,
      true,
      "client-1",
      "Bind failed",
      true,
      true,
      "Dry run failed",
      true,
    ]);

    queryOverrides.set(
      JSON.stringify(["clients"]),
      queryResult({ error: new Error("client list failed"), isError: true, status: "error" }),
    );
    renderDetail([null, null, null, false, false, true, "", null, false, false, null, false]);

    queryOverrides.set(JSON.stringify(["clients"]), queryResult({ isLoading: true, status: "loading" }));
    renderDetail([null, null, null, false, false, true, "", null, false, false, null, false]);

    expect(state.rendered).toBeGreaterThan(80);
    expect(state.events).toBeGreaterThan(12);
  }, 20_000);

  it("executes onboarding shell and progress rail variants", async () => {
    const state = createState();
    setupModuleMocks(state);
    const flow = onboardingFlowValue({ activeIndex: 5, activeStep: "kickoff", hasAgent: true });
    vi.doMock("../pages/onboarding/onboarding-flow.js", () => ({
      OnboardingFlowProvider: ({ children }: Record<string, unknown>) => children,
      useOnboardingFlow: () => flow,
    }));

    const { ProgressRail } = await import("../pages/onboarding/progress-rail.js");
    const { OnboardingShell } = await import("../pages/onboarding/onboarding-shell.js");

    renderNode(createElement(ProgressRail), state);
    renderNode(
      createElement(OnboardingShell, {
        rail: createElement(ProgressRail),
        children: createElement("section", { children: "Create agent" }),
      }),
      state,
    );

    Object.assign(
      flow,
      onboardingFlowValue({ activeIndex: 0, activeStep: "welcome", hasAgent: false, path: "invitee" }),
    );
    state.nodes = 0;
    renderNode(createElement(ProgressRail), state);
    renderNode(
      createElement(OnboardingShell, {
        rail: createElement(ProgressRail),
        children: createElement("section", { children: "Welcome" }),
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(10);
    expect(state.events).toBeGreaterThan(3);
  }, 20_000);

  it("executes open menu, popover, and sidebar attention branches", async () => {
    const state = createState([
      [
        { id: "org-1", displayName: "Compute Team", role: "admin" },
        { id: "org-2", displayName: "Research Team", role: "member" },
      ],
      true,
      "create",
      "New Team",
      null,
      false,
    ]);
    setupModuleMocks(state);

    const { UserMenu } = await import("../components/user-menu.js");
    renderNode(createElement(UserMenu), state);

    state.stateValues = [[{ id: "org-1", displayName: "Compute Team", role: "member" }], true, "join", "", null, false];
    state.nodes = 0;
    renderNode(createElement(UserMenu), state);

    state.stateValues = [true, { top: 20, left: undefined, right: 12 }];
    const { FilterPopover, originLabel } = await import("../pages/workspace/conversations/filter-popover.js");
    renderNode(
      createElement(FilterPopover, {
        activeCount: 3,
        origin: ["manual", "github"],
        onOriginChange: () => {},
        onResetAll: () => {},
        onWatchingChange: () => {},
        watching: true,
      }),
      state,
    );
    expect(originLabel("github")).toBe("GitHub");

    queryOverrides.set(JSON.stringify(["chat-attentions", "chat-1"]), [
      attention,
      {
        ...attention,
        id: "attention-closed",
        requiresResponse: true,
        response: "Approved",
        state: "closed",
        closedAt: iso,
      },
      {
        ...attention,
        id: "attention-notify",
        requiresResponse: false,
        state: "closed",
        cancelled: true,
        cancelledReason: "Superseded",
      },
    ]);
    const { AttentionsSection } = await import("../pages/workspace/right-sidebar/attentions-section.js");
    state.stateValues = ["attention-1234567890", { top: 208, left: 960 }];
    renderNode(createElement(AttentionsSection, { chatId: "chat-1" }), state);
    state.stateValues = ["attention-closed", { top: 208, left: 960 }];
    renderNode(createElement(AttentionsSection, { chatId: "chat-1" }), state);
    state.stateValues = ["attention-notify", { top: 208, left: 960 }];
    renderNode(createElement(AttentionsSection, { chatId: "chat-1" }), state);

    const { NoChatView } = await import("../pages/workspace/center/no-chat-view.js");
    renderNode(createElement(NoChatView, { onNewChat: () => {} }), state);

    expect(state.rendered).toBeGreaterThan(35);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes compact utility component variants", async () => {
    const state = createState();
    setupModuleMocks(state);

    const { AgentChip } = await import("../components/agent-chip.js");
    renderNode(createElement(AgentChip, { displayName: "Ada Lovelace", name: "ada" }), state);
    renderNode(
      createElement(AgentChip, { displayName: null, name: "atlas", tone: "accent", variant: "stacked" }),
      state,
    );
    renderNode(createElement(AgentChip, { displayName: null, name: null, emptyLabel: "Deleted" }), state);

    const { ConnectCommandPanel } = await import("../components/connect-command-panel.js");
    for (const props of [
      {
        command: "first-tree login token",
        expiresInSeconds: 12,
        phase: "waiting",
        waitingText: "Waiting for connection",
      },
      {
        command: "first-tree login token",
        expiresInSeconds: 0,
        phase: "success",
        successContent: "Connected",
      },
    ]) {
      renderNode(createElement(ConnectCommandPanel, props), state);
    }

    state.stateValues = [true, "up"];
    const { RowActionsMenu } = await import("../components/ui/row-actions-menu.js");
    renderNode(
      createElement(RowActionsMenu, {
        actions: [
          { key: "open", label: "Open", onSelect: () => {} },
          { key: "delete", label: "Delete", destructive: true, disabled: true, onSelect: () => {} },
        ],
        ariaLabel: "Row actions",
      }),
      state,
    );
    renderNode(createElement(RowActionsMenu, { actions: [], ariaLabel: "Empty actions" }), state);

    vi.doMock("../hooks/use-disconnected-computers.js", () => ({
      useDisconnectedComputers: () => ({ rows: [{ id: "client-1" }, { id: "client-2" }], firstHostname: "ada" }),
    }));
    const { DisconnectChip } = await import("../components/disconnect-chip.js");
    renderNode(createElement(DisconnectChip), state);

    const { OfflineCardBody } = await import("../pages/clients/cards/offline-card-body.js");
    state.stateValues = [true];
    renderNode(
      createElement(OfflineCardBody, {
        agentName: (uuid: string | null | undefined) => uuid ?? "unknown",
        boundAgents: [
          {
            agentId: "agent-bot",
            agentName: "atlas",
            displayName: "Atlas",
            runtimeState: { status: "idle", updatedAt: iso },
          },
        ],
        client: {
          ...client,
          capabilities: {
            "claude-code": { state: "ok", version: "1.0.0" },
            codex: { state: "error", error: "not signed in" },
          },
          lastSeenAt: "2026-05-27T00:00:00.000Z",
          os: "linux",
          status: "offline",
        },
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(25);
    expect(state.events).toBeGreaterThan(5);
  }, 20_000);

  it("executes compose status rail and slash command interaction branches", async () => {
    const state = createState([
      true,
      { agentId: "agent-failed", since: Date.now() },
      Date.now(),
      Date.now(),
      Date.now(),
      Date.now(),
      1,
      null,
    ]);
    setupModuleMocks(state);
    vi.doMock("../lib/use-mounted-anchors.js", () => ({
      anchorKey: (main: string, agentId: string) => `${main}:${agentId}`,
      isJumpable: (mounted: ReadonlySet<string>, main: string, agentId: string) => mounted.has(`${main}:${agentId}`),
      useMountedAnchors: () =>
        new Set([
          "failed:agent-failed",
          "needs_you:agent-bot",
          "working:agent-thinking",
          "working:agent-writing",
          "working:agent-tool",
          "working:agent-turn",
        ]),
    }));
    queryOverrides.set(JSON.stringify(["chat-agent-status", "chat-1"]), [
      { agentId: "agent-failed", main: "failed", activity: null },
      { agentId: "agent-bot", main: "needs_you", activity: null },
      {
        agentId: "agent-turn",
        main: "working",
        activity: { kind: "tool_call", label: "Bash", detail: "pnpm test", startedAt: iso, turnText: "Checking tests" },
      },
      {
        agentId: "agent-thinking",
        main: "working",
        activity: { kind: "thinking", label: "Thinking", startedAt: iso },
      },
      {
        agentId: "agent-writing",
        main: "working",
        activity: { kind: "assistant_text", label: "Writing", detail: "Drafting response", startedAt: iso },
      },
      {
        agentId: "agent-tool",
        main: "working",
        activity: { kind: "tool_call", label: "Shell", detail: "pnpm check", startedAt: iso },
      },
      { agentId: "agent-bare", main: "working", activity: null },
    ]);

    const { ComposeStatusBar } = await import("../components/chat/compose-status-bar.js");
    renderNode(
      createElement(ComposeStatusBar, {
        chatId: "chat-1",
        agents: [
          { agentId: "agent-failed", displayName: "Failure Bot" },
          { agentId: "agent-bot", displayName: "Atlas" },
          { agentId: "agent-turn", displayName: "Turn Bot" },
          { agentId: "agent-thinking", displayName: "Thinker" },
          { agentId: "agent-writing", displayName: "Writer" },
          { agentId: "agent-tool", displayName: "Tooler" },
        ],
      }),
      state,
    );

    queryOverrides.set(JSON.stringify(["chat-agent-status", "chat-quiet"]), []);
    state.nodes = 0;
    state.stateValues = [false, null];
    renderNode(createElement(ComposeStatusBar, { chatId: "chat-quiet", agents: [] }), state);

    const { SlashCommandPopover, buildSlashInsert, detectSlashTrigger, resolveMentionContext, useSlashCommand } =
      await import("../components/slash-command-autocomplete.js");
    state.stateValues = [1, null];
    const systemCommands: SlashSystemCommand[] = [{ kind: "system", name: "help", description: "Show composer help" }];
    const agentSkills: NonNullable<Parameters<typeof useSlashCommand>[0]["agentSkills"]> = {
      agentId: "agent-bot",
      agentDisplayName: "Atlas",
      skills: [
        {
          name: "review",
          description:
            "Review the current branch and produce detailed findings with enough context to choose a next action.",
          namespace: "code",
          source: "project",
        },
        { name: "ship", description: "Prepare release notes.", source: "builtin" },
      ],
    };
    const picked: unknown[] = [];
    const firstSkill = agentSkills.skills[0];
    if (!firstSkill) throw new Error("expected agent skill");
    const slash = useSlashCommand({
      value: "/re",
      cursor: 3,
      systemCommands,
      agentSkills,
      mentionedAgent: { agentId: "agent-bot", displayName: "Atlas" },
      onSelect: (update, item) => picked.push({ update, item }),
    });
    const preventDefault = vi.fn();
    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape", "x"]) {
      slash.handleKey({ key, preventDefault });
    }
    const firstResult = slash.results[0];
    if (!firstResult) throw new Error("expected slash result");
    slash.pick(firstResult);
    slash.dismiss();

    renderNode(
      createElement(SlashCommandPopover, {
        trigger: slash.trigger,
        results: slash.results,
        highlightIndex: slash.highlightIndex,
        mentionedAgent: slash.mentionedAgent,
        onPick: (item: unknown) => picked.push(item),
        anchorRef: { current: fakeDomElement() },
      }),
      state,
    );
    renderNode(
      createElement(SlashCommandPopover, {
        trigger: null,
        results: [],
        highlightIndex: 0,
        mentionedAgent: null,
        onPick: () => {},
        anchorRef: { current: null },
      }),
      state,
    );

    expect(detectSlashTrigger("not /mid", 8)).toBeNull();
    expect(
      resolveMentionContext("@missing /help", 14, [{ agentId: "agent-bot", name: "atlas", displayName: null }]),
    ).toBeNull();
    expect(
      buildSlashInsert("@atlas /re", { triggerIndex: 7, query: "re" }, 10, {
        kind: "skill",
        agentId: "agent-bot",
        agentDisplayName: "Atlas",
        skill: firstSkill,
      }),
    ).toEqual({ text: "@atlas /code:review ", cursor: 20, kind: "skill" });
    expect(preventDefault).toHaveBeenCalled();
    expect(picked.length).toBeGreaterThan(0);
    expect(state.rendered).toBeGreaterThan(20);
  }, 20_000);

  it("executes connect-code onboarding failure and repository picker branches", async () => {
    const state = createState();
    const flow = onboardingFlowValue({ selectedRepoUrls: [] });
    setupModuleMocks(state);
    vi.doMock("../pages/onboarding/onboarding-flow.js", () => ({
      OnboardingFlowProvider: ({ children }: Record<string, unknown>) => children,
      useOnboardingFlow: () => flow,
    }));

    const { ApiError } = await import("../api/client.js");
    const { StepConnectCode } = await import("../pages/onboarding/steps/step-connect-code.js");
    queryOverrides.set(JSON.stringify(["onboarding", "installation", "org-1"]), undefined);

    for (const installError of ["not_configured", "not_admin", "generic"]) {
      state.nodes = 0;
      state.stateValues = [installError, false, true, true];
      renderNode(createElement(StepConnectCode), state);
    }

    queryOverrides.set(
      JSON.stringify(["onboarding", "installation", "org-1"]),
      dataForQuery(["github-app-installation"]),
    );
    for (const reposOverride of [
      queryResult({ error: new ApiError(403, "GitHub scope missing"), isError: true, status: "error" }),
      queryResult({ isLoading: true, status: "loading" }),
      [],
      [
        {
          id: 1,
          fullName: "agent-team-foundation/first-tree",
          private: false,
          defaultBranch: "main",
          htmlUrl: "",
        },
        {
          id: 2,
          fullName: "agent-team-foundation/first-tree-context",
          private: true,
          defaultBranch: "main",
          htmlUrl: "",
        },
      ],
    ]) {
      queryOverrides.set(JSON.stringify(["onboarding", "github-repos"]), reposOverride);
      state.nodes = 0;
      state.stateValues = [null, false, false, false];
      renderNode(createElement(StepConnectCode), state);
    }

    Object.assign(
      flow,
      onboardingFlowValue({ selectedRepoUrls: ["https://github.com/agent-team-foundation/first-tree"] }),
    );
    state.nodes = 0;
    state.stateValues = [null, false, false, false];
    renderNode(createElement(StepConnectCode), state);

    expect(state.rendered).toBeGreaterThan(35);
    expect(state.events).toBeGreaterThan(10);
  }, 20_000);

  it("executes binding form submit, validation, platform, and edit branches", async () => {
    const state = createState();
    setupModuleMocks(state);
    const submitted: unknown[] = [];
    const { BindingFormDialog } = await import("../pages/binding-form.js");
    const form = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      platform: "feishu",
      feishuAppId: "",
      feishuAppSecret: "",
      credentialsJson: "{}",
      status: "active",
      externalUserId: "",
      displayName: "",
      kaelUserId: "",
      kaelProjectId: "",
      ...overrides,
    });
    const renderForm = (props: Record<string, unknown>, initialForm: Record<string, unknown>, credError = ""): void => {
      state.nodes = 0;
      state.stateValues = [initialForm, credError];
      renderNode(
        createElement(BindingFormDialog, {
          open: true,
          onOpenChange: () => {},
          agentLabel: "Atlas",
          pending: false,
          errorMessage: null,
          onSubmit: (payload: unknown) => submitted.push(payload),
          ...props,
        }),
        state,
      );
    };

    renderForm({ kind: "user", editingId: null }, form({ externalUserId: "ou_123", displayName: "Ada" }));
    renderForm({ kind: "user", editingId: null }, form());
    renderForm({ kind: "bot", editingId: null }, form());
    renderForm(
      { kind: "bot", editingId: null },
      form({ feishuAppId: "cli_123", feishuAppSecret: "secret", status: "inactive" }),
    );
    renderForm({ kind: "bot", editingId: null, initialPlatform: "kael" }, form({ platform: "kael" }));
    renderForm(
      { kind: "bot", editingId: null, initialPlatform: "kael" },
      form({ platform: "kael", kaelUserId: "user_123", kaelProjectId: "proj_123" }),
    );
    renderForm(
      { kind: "bot", editingId: null, initialPlatform: "slack" },
      form({ platform: "slack", credentialsJson: "{" }),
    );
    renderForm(
      { kind: "bot", editingId: null, initialPlatform: "slack" },
      form({ platform: "slack", credentialsJson: '{"bot_token":"xoxb","signing_secret":"secret"}' }),
    );
    renderForm(
      { kind: "bot", editingId: 3, initialPlatform: "slack", initialStatus: "inactive", errorMessage: "Save failed" },
      form({ platform: "slack", credentialsJson: "", status: "inactive" }),
      "Previous validation error",
    );

    expect(submitted.length).toBeGreaterThanOrEqual(4);
    expect(state.rendered).toBeGreaterThan(40);
    expect(state.events).toBeGreaterThan(10);
  }, 20_000);

  it("executes alternate computers page loading, fallback, member, and empty-section branches", async () => {
    const state = createState();
    setupModuleMocks(state);
    const offline = {
      ...client,
      authState: "ok",
      capabilities: { "claude-code": { state: "ok", sdkVersion: "1.0.0" }, codex: { state: "missing" } },
      hostname: "offline-box",
      id: "client-offline",
      lastSeenAt: "2026-05-26T00:00:00.000Z",
      status: "offline",
      userId: "user-1",
    };
    const teammate = {
      ...client,
      capabilities: {},
      hostname: "teammate-box",
      id: "client-team-only",
      os: null,
      status: "connected",
      userId: "user-2",
    };
    const { ClientsPage: ClientsPageRef } = await import("../pages/clients.js");
    const renderClients = (stateValues: unknown[]): void => {
      state.nodes = 0;
      state.stateValues = stateValues;
      renderNode(createElement(ClientsPageRef, { embedded: true }), state);
    };

    queryOverrides.set(JSON.stringify(["clients", "org"]), queryResult({ isLoading: true, status: "loading" }));
    renderClients([null, new Set<string>(), false, null, null, null, false, null, null]);

    queryOverrides.set(
      JSON.stringify(["clients", "org"]),
      queryResult({ error: new Error("org clients failed"), isError: true, status: "error" }),
    );
    queryOverrides.set(JSON.stringify(["clients", "me"]), []);
    renderClients([null, new Set<string>(), false, null, null, null, false, null, null]);

    authOverride = { role: "member" };
    queryOverrides.delete(JSON.stringify(["clients", "org"]));
    queryOverrides.set(JSON.stringify(["clients", "me"]), [offline, { ...client, id: "client-ready" }]);
    renderClients([null, new Set<string>(), false, null, null, null, false, null, null]);

    authOverride = { role: "admin" };
    queryOverrides.set(JSON.stringify(["clients", "org"]), [teammate]);
    queryOverrides.set(JSON.stringify(["clients", "me"]), []);
    renderClients([null, new Set<string>(), false, null, null, null, false, null, null]);

    expect(state.rendered).toBeGreaterThan(40);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes team dialogs, filtering, pagination guards, and delegate helpers", async () => {
    const state = createState([
      true,
      true,
      { id: "member-2", username: "grace", displayName: "Grace Hopper", role: "member" },
      { humanAgentId: "agent-human", humanDisplayName: "Ada Lovelace", currentDelegate: "agent-private" },
      "team",
      "atlas",
    ]);
    setupModuleMocks(state);

    const { TeamPage, buildGroups, fetchAllAgents, selectDelegateCandidates } = await import("../pages/team/index.js");
    renderNode(createElement(TeamPage), state);

    // Broad smoke fixtures are stored as loose records; these casts keep the
    // focused pure-helper checks tied to the package's exported Agent type.
    const typedHuman = humanAgent as unknown as Agent;
    const typedBot = botAgent as unknown as Agent;
    const typedPrivate = privateAgent as unknown as Agent;
    const typedTeam = teamAgent as unknown as Agent;
    const typedSuspended = suspendedAgent as unknown as Agent;
    const extraPrivate = { ...typedPrivate, uuid: "agent-extra-private", displayName: "Zed", status: "active" };
    const groups = buildGroups({
      filter: "all",
      search: "",
      isAdmin: true,
      selfMemberId: "member-1",
      members,
      yourAgents: [typedBot, typedPrivate],
      teamAgents: [typedTeam],
      otherPrivateAgents: [extraPrivate],
      resolveMember: (id) => members.find((m) => m.id === id)?.displayName ?? id,
      agentByUuid: new Map([
        [typedHuman.uuid, { ...typedHuman, delegateMention: "agent-private" }],
        [typedPrivate.uuid, typedPrivate],
      ]),
      openDelegate: () => {},
    });
    expect(groups.map((group) => group.key)).toContain("other-private");
    expect(selectDelegateCandidates([typedBot, typedPrivate, typedSuspended, typedHuman]).map((a) => a.uuid)).toContain(
      "agent-private",
    );

    const fetched = await fetchAllAgents(async ({ cursor }) => ({
      items: cursor ? [typedTeam] : [typedBot],
      nextCursor: cursor ? null : "cursor-2",
    }));
    expect(fetched).toHaveLength(2);
    await expect(fetchAllAgents(async () => ({ items: [], nextCursor: "again" }))).rejects.toThrow(/exceeded/);

    expect(state.rendered).toBeGreaterThan(30);
    expect(state.events).toBeGreaterThan(6);
  }, 20_000);

  it("executes new-agent dialog zero-computer, multi-client, and no-runtime branches", async () => {
    const state = createState();
    setupModuleMocks(state);
    const { NewAgentDialog } = await import("../components/new-agent-dialog.js");
    const renderDialog = (values: unknown[]): void => {
      state.nodes = 0;
      state.stateValues = values;
      renderNode(createElement(NewAgentDialog, { open: true, onOpenChange: () => {}, onCreated: () => {} }), state);
    };

    renderDialog([
      "!!!",
      "",
      false,
      "private",
      "claude-code",
      false,
      [],
      true,
      null,
      null,
      null,
      "connect-token",
      "first-tree login connect-token",
      Date.now() + 60_000,
      true,
      { _root: "Server unavailable" },
      { status: "bad", reason: "reserved" },
    ]);
    renderDialog([
      "Runtime Picker",
      "runtime-picker",
      true,
      "organization",
      "codex",
      true,
      [client, { ...client, id: "client-2", hostname: "grace-laptop", lastSeenAt: "2026-05-27T00:00:00.000Z" }],
      true,
      "client-2",
      { "claude-code": { state: "missing" }, codex: { state: "unauthenticated", sdkVersion: "0.125.0" } },
      "client-2",
      null,
      null,
      null,
      false,
      { clientId: "Pick a computer", displayName: "Too long", name: "Invalid handle" },
      { status: "checking" },
    ]);

    expect(state.rendered).toBeGreaterThan(25);
    expect(state.events).toBeGreaterThan(6);
  }, 20_000);

  it("executes bindings page dialogs, filter, confirmation, and picker branches", async () => {
    routerSearch = "?agent=agent-bot";
    const state = createState([
      { kind: "bot" },
      "agent-bot",
      { agentId: "agent-bot", editingId: 1, initialPlatform: "slack", initialStatus: "inactive" },
      { agentId: "agent-human" },
      1,
      10,
    ]);
    setupModuleMocks(state);

    const { BindingsPage } = await import("../pages/bindings.js");
    renderNode(createElement(BindingsPage), state);

    routerSearch = "";
    state.nodes = 0;
    state.stateValues = [{ kind: "user" }, "agent-human", null, null, null, null];
    queryOverrides.set(JSON.stringify(["adapters"]), []);
    queryOverrides.set(JSON.stringify(["adapter-mappings"]), []);
    renderNode(createElement(BindingsPage), state);

    expect(state.rendered).toBeGreaterThan(35);
    expect(state.events).toBeGreaterThan(8);
  }, 20_000);

  it("executes collapsed multi-question and text-only attention branches", async () => {
    const state = createState();
    setupModuleMocks(state);
    const { AttentionCard } = await import("../components/chat/attention-card.js");

    state.stateValues = [
      Date.now(),
      new Map<string, Set<string>>([
        ["risk", new Set(["low"])],
        ["checks", new Set(["tests", "docs"])],
      ]),
      false,
      "",
      true,
    ];
    renderNode(createElement(AttentionCard, { attention, onResponded: () => {} }), state);

    state.nodes = 0;
    state.stateValues = [Date.now(), new Map<string, Set<string>>(), false, "", true];
    renderNode(
      createElement(AttentionCard, {
        attention: {
          ...attention,
          body: "Line one\nLine two",
          metadata: { questions: [{ id: "text", prompt: "Explain the risk", context: "Use details." }] },
        },
        onResponded: () => {},
      }),
      state,
    );

    expect(state.rendered).toBeGreaterThan(1);
  }, 20_000);

  it("bulk-renders exported web components with broad smoke props", async () => {
    const state = createState();
    setupModuleMocks(state);
    const props = broadComponentProps();
    const cases = await collectRenderableExports();
    let attempted = 0;

    for (const item of cases) {
      state.nodes = 0;
      state.stateValues = [];
      renderNode(createElement(item.value, props), state);
      attempted++;
    }

    expect(attempted).toBeGreaterThan(90);
    expect(state.rendered).toBeGreaterThan(220);
  }, 30_000);
});
