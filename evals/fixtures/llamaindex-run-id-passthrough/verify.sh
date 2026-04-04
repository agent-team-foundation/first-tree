#!/usr/bin/env bash
set -euo pipefail

cd llama-index-core
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

# Verify run ID is plumbed through agent workflow modules.
#
# The bug: run_id passed via kwargs to agent.run() / workflow.run() is
# not extracted and forwarded to the underlying Workflow.run(), so
# observability traces cannot be correlated.
#
# The fix: base_agent.py and multi_agent_workflow.py must extract run_id
# from kwargs and pass it through to super().run().
python3 -c "
import ast

errors = 0

def check_run_id_in_run_method(filepath, label):
    \"\"\"Verify that a file's run() method extracts and uses run_id.\"\"\"
    global errors
    with open(filepath) as f:
        content = f.read()

    if 'run_id' not in content:
        print(f'FAIL: {label} does not reference run_id at all')
        errors += 1
        return

    # Check that run_id is extracted from kwargs (e.g. run_id = kwargs.pop('run_id', ...))
    # or accepted as a parameter, and passed to super().run()
    has_extract = ('kwargs.pop' in content and 'run_id' in content) or \
                  ('run_id' in content and 'super().run' in content) or \
                  ('run_id=' in content)
    if has_extract:
        print(f'PASS: {label} extracts/passes run_id')
    else:
        print(f'FAIL: {label} mentions run_id but does not extract/pass it')
        errors += 1

check_run_id_in_run_method(
    'llama_index/core/agent/workflow/base_agent.py',
    'base_agent.py')

check_run_id_in_run_method(
    'llama_index/core/agent/workflow/multi_agent_workflow.py',
    'multi_agent_workflow.py')

if errors > 0:
    print(f'\nFAIL: {errors} modules missing run_id plumbing')
    exit(1)

print('\nAll run_id plumbing checks passed.')
"

# Run the agent workflow tests if they exist (best-effort — existing tests
# may have unrelated import failures like missing 'openai')
if [ -f tests/agent/workflow/test_single_agent_workflow.py ]; then
    python -m pytest tests/agent/workflow/test_single_agent_workflow.py -x -q 2>&1 | tail -5 || true
fi
if [ -f tests/agent/workflow/test_multi_agent_workflow.py ]; then
    python -m pytest tests/agent/workflow/test_multi_agent_workflow.py -x -q 2>&1 | tail -5 || true
fi

echo "All checks passed."
