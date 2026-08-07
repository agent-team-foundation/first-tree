import type { FirstTreeReadEvalCase } from "./types.js";

const JWT_AUTH_EXPECTED_FACTS = [
  "User JWT auth is the unified authorization surface.",
  "Route scopes must be checked against live organization membership before cross-org actions.",
  "HTTP routes must follow the repo path conventions document before auth or multi-org changes.",
] as const;

const NAVIGATION_EXPECTED_FACTS = ["Top-level Context Tree domains are systems, domains, and operations."] as const;

const RELEASE_AUDIT_EXPECTED_FACTS = [
  "Production releases require completed security-audit approval before deployment.",
] as const;

const ROLLOUT_EXPECTED_FACTS = [
  "Every production rollout must keep a single reviewable scope across release and billing policy.",
  "Production releases require completed security-audit approval before deployment.",
  "Billing changes must roll out after the core release reaches stable monitoring.",
] as const;

const EVAL_SOURCE_REPOSITORY = "https://github.com/example/context-tree.git";
const JWT_SOURCE_PATHS = [
  "systems/server/auth/jwt/NODE.md",
  "systems/server/auth/scopes/NODE.md",
  "systems/server/http/routes/NODE.md",
] as const;
const JWT_SUMMARY_CONCEPTS = [
  ["JWT"],
  ["route", "路由"],
  ["membership", "成员"],
  ["narrowed", "ruled out", "requires", "must", "收窄", "排除", "必须"],
] as const;

export const FIRST_TREE_READ_CASES: readonly FirstTreeReadEvalCase[] = [
  {
    description: "Blank workspace with first-tree-read installed and a casual prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: false,
    id: "blank-casual-no-trigger",
    impactNote: { mode: "absent" },
    managedTransport: null,
    prompt: "Please explain the Pomodoro technique in one sentence.",
    promptAlternates: ["How is your day going?"],
    readMode: "managed",
    workspaceKind: "blank",
  },
  {
    description: "Context Tree workspace with a software engineering prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-software-trigger",
    impactNote: {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: {
        allowedNodePaths: JWT_SOURCE_PATHS,
        repository: EVAL_SOURCE_REPOSITORY,
      },
      sourceCount: { max: 3, min: 1 },
      summaryConcepts: JWT_SUMMARY_CONCEPTS,
    },
    managedTransport: "send",
    prompt: "For this project, what constraints should JWT auth routes follow?",
    promptAlternates: ["Analyze server route naming and multi-org permission boundaries for this project."],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
  {
    description: "BYO task that must select one exact SCOPE route before discovery.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "byo-scope-route-trigger",
    impactNote: {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: {
        allowedNodePaths: JWT_SOURCE_PATHS,
        repository: EVAL_SOURCE_REPOSITORY,
      },
      sourceCount: { max: 3, min: 1 },
      summaryConcepts: JWT_SUMMARY_CONCEPTS,
    },
    managedTransport: null,
    prompt:
      "For this BYO Context Tree task, use the locally authorized SCOPE router and answer: what constraints should JWT auth routes follow?",
    promptAlternates: [
      "Route this BYO task from the complete eligible SCOPE body, read the selected exact Context Tree once, then explain multi-org JWT route constraints.",
    ],
    readMode: "byo",
    workspaceKind: "byo-context-tree",
  },
  {
    description: "Context Tree workspace with a non-software prompt.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: false,
    id: "tree-nonsoftware-no-trigger",
    impactNote: { mode: "absent" },
    managedTransport: null,
    prompt: "Recommend a weekend cooking menu.",
    promptAlternates: ["Write a short poem about summer."],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
  {
    description: "Managed tree navigation read that must not claim material decision influence.",
    expectedFacts: NAVIGATION_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-navigation-no-impact",
    impactNote: { mode: "absent" },
    managedTransport: "send",
    prompt:
      "Browse this Context Tree and list only its three top-level domain names. Do not make a design or implementation choice.",
    promptAlternates: ["What are the three top-level domains in this Context Tree? Return only their names."],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
  {
    description: "Chinese unresolved conflict that must not be rewritten as an already changed plan.",
    expectedFacts: RELEASE_AUDIT_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-conflict-chinese",
    impactNote: {
      effect: "conflicted",
      language: "zh",
      mode: "present",
      requiredSourceLabels: ["Rollout Policy"],
      sourceAuthority: {
        allowedNodePaths: ["product/release/rollout-policy/NODE.md"],
        repository: EVAL_SOURCE_REPOSITORY,
      },
      sourceCount: { max: 1, min: 1 },
      summaryConcepts: [["发布日期", "发布日"], ["安全审计"], ["仍待", "尚未", "需要决定", "需升级"]],
      summaryForbidden: ["已调整", "已解决", "已排除", "已完成取舍"],
    },
    managedTransport: "send",
    prompt:
      "发布日期已固定为 8 月 20 日且不能移动，但现在没有足够时间完成新的安全审计。请根据 Context Tree 判断能否直接发布；不要替我更改日期或跳过审计，若冲突未决就明确指出。",
    promptAlternates: [
      "固定发布日期与发布前安全审计无法同时满足。请用中文依据 Context Tree 说明冲突，不要假装方案已经调整。",
    ],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
  {
    description: "Three-source note with a root node and duplicate titles that require readable disambiguation.",
    expectedFacts: ROLLOUT_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "tree-readable-multi-source-note",
    impactNote: {
      effect: "constrained",
      language: "en",
      mode: "present",
      requiredSourceLabels: ["First Tree Read Eval Context", "Release · Rollout Policy", "Billing · Rollout Policy"],
      sourceAuthority: {
        allowedNodePaths: [
          "NODE.md",
          "product/release/rollout-policy/NODE.md",
          "product/billing/rollout-policy/NODE.md",
        ],
        repository: EVAL_SOURCE_REPOSITORY,
      },
      sourceCount: { max: 3, min: 3 },
      summaryConcepts: [["rollout"], ["reviewable scope"], ["audit"], ["billing"]],
    },
    managedTransport: "send",
    prompt:
      "Plan a production billing rollout. Apply the Context Tree's root rollout-scope rule, release security gate, and billing ordering constraint, and explain the resulting implementation boundary.",
    promptAlternates: [
      "Use the root rollout rule plus both release and billing rollout policies to constrain a production billing launch.",
    ],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
];

export const FIRST_TREE_READ_PERIODIC_CASES: readonly FirstTreeReadEvalCase[] = [
  {
    briefingMode: "runtime-generated",
    description: "Context Tree workspace with runtime-generated briefing and installed First Tree family skills.",
    expectedFacts: JWT_AUTH_EXPECTED_FACTS,
    expectedTrigger: true,
    id: "first-tree-read-runtime-generated-briefing-periodic",
    impactNote: {
      effect: "constrained",
      language: "en",
      mode: "present",
      sourceAuthority: {
        allowedNodePaths: JWT_SOURCE_PATHS,
        repository: EVAL_SOURCE_REPOSITORY,
      },
      sourceCount: { max: 3, min: 1 },
      summaryConcepts: JWT_SUMMARY_CONCEPTS,
    },
    managedTransport: "send",
    prompt:
      "Use this workspace's current Context Tree to answer: what constraints should JWT auth routes follow for this project?",
    promptAlternates: ["Use the current Context Tree before answering: how should multi-org JWT route scopes work?"],
    readMode: "managed",
    workspaceKind: "context-tree",
  },
];

export function findFirstTreeReadCase(id: string): FirstTreeReadEvalCase | null {
  for (const evalCase of FIRST_TREE_READ_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}

export function findFirstTreeReadPeriodicCase(id: string): FirstTreeReadEvalCase | null {
  for (const evalCase of FIRST_TREE_READ_PERIODIC_CASES) {
    if (evalCase.id === id) return evalCase;
  }
  return null;
}
