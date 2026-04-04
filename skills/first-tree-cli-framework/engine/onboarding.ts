import ONBOARDING_TEXT from "#skill/references/onboarding.md";

export { ONBOARDING_TEXT };

type Output = (text: string) => void;

export function runOnboarding(output: Output = console.log): number {
  output(ONBOARDING_TEXT);
  return 0;
}
