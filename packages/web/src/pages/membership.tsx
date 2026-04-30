import { PageHeader } from "../components/ui/page-header.js";
import { MembershipPanel } from "./membership-panel.js";

export function MembershipPage() {
  return (
    <div className="-m-6">
      <PageHeader title="Membership" subtitle="Your access in the current team" />
      <div style={{ padding: "var(--sp-4) var(--sp-5) var(--sp-7)" }}>
        <MembershipPanel />
      </div>
    </div>
  );
}
