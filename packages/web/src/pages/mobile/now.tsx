// Legacy import compatibility. The product route is now `/m/work`; keeping
// this named export prevents downstream previews/tests from breaking while
// `/m/now` redirects to the unified Work surface.
export { MobileWorkPage as MobileNowPage } from "./work.js";
