import type { SubcommandModule } from "../types.js";

export function runDoctorCommand(): void {
  console.log("first-tree hub doctor is not implemented yet.");
}

export const doctorCommand: SubcommandModule = {
  name: "doctor",
  alias: "",
  summary: "",
  description: "Check hub configuration.",
  action: runDoctorCommand,
};
