(() => {
  let storedTheme = null;
  try {
    storedTheme = localStorage.getItem("theme");
  } catch {
    // Private or sandboxed contexts may deny storage. Use the system theme.
    storedTheme = null;
  }

  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (storedTheme === "dark" || (!storedTheme && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
})();
