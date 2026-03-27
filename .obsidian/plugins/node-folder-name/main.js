/*
 * Node Folder Name Plugin
 *
 * Displays NODE.md files using their parent folder name everywhere:
 * - Graph view (monkey-patches GraphNode.prototype.getDisplayText)
 * - Tab headers
 * - File explorer
 *
 * Injects virtual connections into the graph:
 * - NODE.md → all sibling files in the same folder
 * - NODE.md → child NODE.md files in immediate subdirectories
 * - members/<owner>/NODE.md → every node they own (from frontmatter `owners`)
 *
 * Colors nodes by type: blue (tree/branch), green (leaf), amber (member).
 */

const { Plugin, TFile, TFolder } = require("obsidian");

const NODE_BASENAME = "NODE.md";
const MEMBER_NODE_COLOR = 0xe6a23c; // amber/orange for member nodes
const TREE_NODE_COLOR = 0x409eff;   // blue for tree nodes (NODE.md with children)
const LEAF_NODE_COLOR = 0x67c23a;   // green for leaf nodes (non-NODE.md files)

class NodeFolderNamePlugin extends Plugin {
  _graphPatched = false;
  _origGraphGetDisplayText = null;
  _origGetFillColor = null;
  _graphProto = null;
  _injectedLinks = []; // track what we injected for cleanup
  _treeNodes = new Set(); // NODE.md files that have child NODE.md (branch nodes)

  async onload() {
    this.app.workspace.onLayoutReady(() => {
      this.injectFolderLinks();
      this.patchFileExplorer();
      this.patchMarkdownViews();
      this.tryPatchGraph();
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.patchFileExplorer();
        this.patchMarkdownViews();
        this.tryPatchGraph();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        setTimeout(() => this.patchMarkdownViews(), 100);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        setTimeout(() => this.patchMarkdownViews(), 100);
      })
    );

    // Re-inject links when files are created, deleted, or renamed
    this.registerEvent(
      this.app.vault.on("create", () => {
        setTimeout(() => this.injectFolderLinks(), 200);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", () => {
        setTimeout(() => this.injectFolderLinks(), 200);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", () => {
        setTimeout(() => this.injectFolderLinks(), 200);
      })
    );
  }

  onunload() {
    // Restore original graph methods
    if (this._graphProto) {
      if (this._origGraphGetDisplayText) {
        this._graphProto.getDisplayText = this._origGraphGetDisplayText;
        this._origGraphGetDisplayText = null;
      }
      if (this._origGetFillColor) {
        this._graphProto.getFillColor = this._origGetFillColor;
        this._origGetFillColor = null;
      }
      this.refreshGraphViews();
    }

    // Remove injected links
    this.removeInjectedLinks();
  }

  /**
   * Get the display name for a NODE.md file path.
   */
  getFolderName(filePath) {
    if (!filePath || !filePath.endsWith(NODE_BASENAME)) return null;
    const parts = filePath.split("/");
    if (parts.length < 2) return "root";
    return parts[parts.length - 2];
  }

  /**
   * Inject virtual links into resolvedLinks so the graph shows folder structure.
   *
   * For each NODE.md:
   * - Add a link from NODE.md → every other .md file in the same folder
   * - Add a link from NODE.md → NODE.md in each immediate child folder
   */
  injectFolderLinks() {
    // Clean up previous injections first
    this.removeInjectedLinks();
    this._treeNodes.clear();

    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const allFiles = this.app.vault.getFiles();

    // Find all NODE.md files
    const nodeFiles = allFiles.filter((f) => f.name === NODE_BASENAME);

    // Build the set of tree nodes (NODE.md that have child NODE.md in subdirs)
    for (const nodeFile of nodeFiles) {
      const nodeDir = nodeFile.parent;
      if (!nodeDir || !nodeDir.children) continue;
      for (const child of nodeDir.children) {
        if (child instanceof TFolder) {
          const childNodePath = child.path + "/" + NODE_BASENAME;
          if (this.app.vault.getAbstractFileByPath(childNodePath)) {
            this._treeNodes.add(nodeFile.path);
            break;
          }
        }
      }
    }

    for (const nodeFile of nodeFiles) {
      const nodeDir = nodeFile.parent;
      if (!nodeDir) continue;

      // Ensure this NODE.md has an entry in resolvedLinks
      if (!resolvedLinks[nodeFile.path]) {
        resolvedLinks[nodeFile.path] = {};
        this._injectedLinks.push({ type: "source", path: nodeFile.path });
      }

      const links = resolvedLinks[nodeFile.path];

      // 1. NODE.md → all sibling .md files in the same folder
      if (nodeDir.children) {
        for (const child of nodeDir.children) {
          if (
            child instanceof TFile &&
            child.extension === "md" &&
            child.path !== nodeFile.path
          ) {
            if (links[child.path] === undefined) {
              links[child.path] = 1;
              this._injectedLinks.push({
                type: "link",
                source: nodeFile.path,
                target: child.path,
              });
            }
          }
        }
      }

      // 2. NODE.md → child directory NODE.md files
      if (nodeDir.children) {
        for (const child of nodeDir.children) {
          if (child instanceof TFolder) {
            const childNodePath = child.path + "/" + NODE_BASENAME;
            const childNodeFile =
              this.app.vault.getAbstractFileByPath(childNodePath);
            if (childNodeFile && childNodeFile instanceof TFile) {
              if (links[childNodeFile.path] === undefined) {
                links[childNodeFile.path] = 1;
                this._injectedLinks.push({
                  type: "link",
                  source: nodeFile.path,
                  target: childNodeFile.path,
                });
              }
            }
          }
        }
      }
    }

    // 3. Owner → owned nodes (from frontmatter `owners` field)
    const allMdFiles = allFiles.filter((f) => f.extension === "md");
    for (const file of allMdFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache || !cache.frontmatter || !cache.frontmatter.owners) continue;

      const owners = cache.frontmatter.owners;
      if (!Array.isArray(owners)) continue;

      for (const owner of owners) {
        if (!owner) continue;
        const memberNodePath = "members/" + owner + "/" + NODE_BASENAME;
        const memberFile =
          this.app.vault.getAbstractFileByPath(memberNodePath);
        if (!memberFile || !(memberFile instanceof TFile)) continue;

        // Inject link: member NODE.md → owned file
        if (!resolvedLinks[memberFile.path]) {
          resolvedLinks[memberFile.path] = {};
          this._injectedLinks.push({ type: "source", path: memberFile.path });
        }

        const memberLinks = resolvedLinks[memberFile.path];
        if (memberLinks[file.path] === undefined) {
          memberLinks[file.path] = 1;
          this._injectedLinks.push({
            type: "link",
            source: memberFile.path,
            target: file.path,
          });
        }
      }
    }
  }

  /**
   * Remove all virtual links we previously injected.
   */
  removeInjectedLinks() {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;

    for (const entry of this._injectedLinks) {
      if (entry.type === "link") {
        if (resolvedLinks[entry.source]) {
          delete resolvedLinks[entry.source][entry.target];
        }
      } else if (entry.type === "source") {
        // Only delete the source entry if it's empty (we created it)
        if (
          resolvedLinks[entry.path] &&
          Object.keys(resolvedLinks[entry.path]).length === 0
        ) {
          delete resolvedLinks[entry.path];
        }
      }
    }

    this._injectedLinks = [];
  }

  /**
   * Monkey-patch GraphNode.prototype.getDisplayText on any open graph view.
   */
  tryPatchGraph() {
    if (this._graphPatched) return;

    const graphLeaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];

    for (const leaf of graphLeaves) {
      const view = leaf.view;
      if (!view || !view.renderer) continue;

      const nodes = view.renderer.nodes;
      if (!nodes || nodes.length === 0) {
        setTimeout(() => this.tryPatchGraph(), 500);
        return;
      }

      const firstNode = nodes[0] || (nodes.first && nodes.first());
      if (!firstNode) continue;

      const proto = Object.getPrototypeOf(firstNode);
      if (!proto || !proto.getDisplayText) continue;

      this._origGraphGetDisplayText = proto.getDisplayText;
      this._graphProto = proto;

      const self = this;
      proto.getDisplayText = function () {
        const folderName = self.getFolderName(this.id);
        if (folderName) return folderName;
        return self._origGraphGetDisplayText.call(this);
      };

      // Patch getFillColor to color by node type.
      // Format: { a: <alpha 0-1>, rgb: <hex number> }
      this._origGetFillColor = proto.getFillColor;
      proto.getFillColor = function () {
        if (self.isMemberNode(this.id)) {
          return { a: 1, rgb: MEMBER_NODE_COLOR };
        }
        if (self._treeNodes.has(this.id)) {
          return { a: 1, rgb: TREE_NODE_COLOR };
        }
        if (this.id && this.id.endsWith(NODE_BASENAME)) {
          // NODE.md without children = leaf domain node
          return { a: 1, rgb: LEAF_NODE_COLOR };
        }
        return self._origGetFillColor.call(this);
      };

      this._graphPatched = true;

      // Update existing rendered labels and trigger re-render
      for (const node of nodes) {
        if (node.text) {
          node.text.text = node.getDisplayText();
        }
      }
      if (view.renderer.changed) {
        view.renderer.changed();
      }

      break;
    }
  }

  /**
   * Check if a file path belongs to a member node (under members/ directory).
   */
  isMemberNode(filePath) {
    return filePath && filePath.startsWith("members/") && filePath.endsWith(NODE_BASENAME);
  }

  /**
   * Refresh all open graph views.
   */
  refreshGraphViews() {
    const graphLeaves = [
      ...this.app.workspace.getLeavesOfType("graph"),
      ...this.app.workspace.getLeavesOfType("localgraph"),
    ];
    for (const leaf of graphLeaves) {
      const view = leaf.view;
      if (view && view.renderer) {
        const nodes = view.renderer.nodes || [];
        for (const node of nodes) {
          if (node.text) {
            node.text.text = node.getDisplayText();
          }
        }
        if (view.renderer.changed) {
          view.renderer.changed();
        }
      }
    }
  }

  /**
   * Patch file explorer tree items.
   */
  patchFileExplorer() {
    const fileExplorers = this.app.workspace.getLeavesOfType("file-explorer");
    fileExplorers.forEach((leaf) => {
      const fileItems = leaf.view.fileItems;
      if (!fileItems) return;

      Object.keys(fileItems).forEach((path) => {
        if (path.endsWith(NODE_BASENAME)) {
          const item = fileItems[path];
          const titleEl =
            item.titleEl ||
            (item.selfEl &&
              item.selfEl.querySelector(".nav-file-title-content"));
          if (titleEl) {
            const folderName = this.getFolderName(path);
            if (folderName && titleEl.innerText !== folderName) {
              titleEl.innerText = folderName;
            }
          }
        }
      });
    });
  }

  /**
   * Patch open markdown views (tabs) to show folder name in tab title.
   */
  patchMarkdownViews() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view &&
        leaf.view.file &&
        leaf.view.file.path.endsWith(NODE_BASENAME)
      ) {
        const folderName = this.getFolderName(leaf.view.file.path);

        if (leaf.view._nodeFolderPatched === undefined) {
          leaf.view._nodeFolderPatched = true;
          const origGetDisplayText = leaf.view.getDisplayText.bind(leaf.view);
          leaf.view.getDisplayText = () => folderName || origGetDisplayText();
        }

        const tabHeader = leaf.tabHeaderInnerTitleEl;
        if (tabHeader && tabHeader.innerText !== folderName) {
          tabHeader.innerText = folderName;
        }
      }
    });
  }
}

module.exports = NodeFolderNamePlugin;
