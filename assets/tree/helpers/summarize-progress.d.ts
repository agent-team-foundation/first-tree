export function parseProgressMarkdown(markdown: string): Array<{
  group: string;
  tasks: Array<{ text: string; done: boolean }>;
}>;

export interface ProgressSummary {
  integration: { completed: number; total: number };
  treeContent: {
    completed: number;
    total: number;
    remaining: Array<{ group: string; text: string }>;
  };
  verification: { completed: number; total: number };
}

export function summarizeProgressMarkdown(markdown: string): ProgressSummary;
export function formatProgressSummary(summary: ProgressSummary): string;
