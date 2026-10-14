/** Starter workflow written by `accesswright init`. */
export function renderWorkflowTemplate(options: { actionRef: string }): string {
  return `name: Accessibility repair
on:
  workflow_dispatch:
  schedule:
    - cron: "0 6 * * 1"
permissions:
  contents: write
  pull-requests: write
jobs:
  accesswright:
    runs-on: ubuntu-latest
    steps:
      - uses: ${options.actionRef}
`;
}
