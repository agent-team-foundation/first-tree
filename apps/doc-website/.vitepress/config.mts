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
      { text: "cli", link: "/cli/" },
      { text: "cloud", link: "/cloud/" },
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
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/vuejs/vitepress" },
    ],
  },
});
