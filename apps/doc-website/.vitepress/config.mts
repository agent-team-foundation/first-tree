import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  srcDir: "docs",
  lastUpdated: true,
  cleanUrls: true,
  metaChunk: true,
  title: "First Tree Doc",
  description: "First Tree Doc",
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: "concept", link: "/concept/" },
      { text: "cli", link: "/cli/" },
      { text: "cloud", link: "/cloud/" },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/agent-team-foundation/first-tree",
      },
    ],

    sidebar: {
      "/cli/": {
        base: "/cli/",
        items: [{ text: "CLI", link: "/cli/" }],
      },
      "/cloud/": {
        base: "/cloud/",
        items: [{ text: "Cloud", link: "/cloud/" }],
      },
      "/concept/": {
        base: "/concept/",
        items: [{ text: "Concept", link: "/concept/" }],
      },
    },
  },
});
