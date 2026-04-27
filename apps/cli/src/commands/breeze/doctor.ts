import type { SubcommandModule } from "../types.js";

export function runDoctorCommand(): void {
  console.log("first-tree breeze doctor is not implemented yet.");
}

export const doctorCommand: SubcommandModule = {
  name: "doctor",
  alias: "",
  summary: "",
  description: "Check breeze workflow configuration.",
  action: runDoctorCommand,
};
