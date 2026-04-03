---
title: Tools
owners: [*]
---

# Tools

30+ tools organized into 10 domains, following a `domain_action_target` naming convention:

| Domain | Examples | Description |
|--------|----------|-------------|
| **react** | `send_message`, `manage_todos` | Communication with user, task tracking |
| **file** | `file_read`, `file_get_url`, `file_download`, `file_present` | Project file operations (see [file-tools.md](file-tools.md)) |
| **document** | `doc_read_overview`, `doc_read_section`, `doc_search` | Structured document analysis |
| **web** | `web_search`, `web_fetch` | Internet search and page fetching |
| **browser** | `browser_navigate`, `browser_read`, `browser_computer`, `browser_find`, `browser_tabs` | Chrome control (see [/environment/browser](../environment/browser.md)) |
| **sandbox** | `sandbox_run` | Isolated code execution (see [/environment/sandbox](../environment/sandbox.md)) |
| **desktop** | `desktop_run` | Local machine control (see [/environment/desktop](../environment/desktop.md)) |
| **slides** | `slides_list`, `slides_generate_*`, `slides_present_styles` | Slide generation with visual design |
| **subtasks** | `subtask_dispatch`, `subtask_check` | Dispatch work to sub-agents (RESEARCHER, CODER, CLAUDE_CODE) |
| **memory** | `memory_search`, `memory_read_detail` | Archival memory retrieval |
| **cronjob** | `schedule_manage` | Scheduled task management |
| **skills** | `skill_activate`, `skill_render_html` | Skill/plugin execution |

soft_links: [/kael/environment, /kael/knowledge]
