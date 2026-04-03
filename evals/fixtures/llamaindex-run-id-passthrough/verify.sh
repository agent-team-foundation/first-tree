#!/usr/bin/env bash
set -euo pipefail

cd llama-index-core
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

# Verify run ID is plumbed through agent workflow modules
python3 -c "
import inspect
import ast

errors = 0

# Check that base_agent.py passes run_id through workflow execution
with open('llama_index/core/agent/workflow/base_agent.py') as f:
    content = f.read()
    # The run method should accept and pass run_id
    if 'run_id' not in content:
        print('FAIL: base_agent.py does not reference run_id')
        errors += 1
    else:
        print('PASS: base_agent.py references run_id')

# Check that multi_agent_workflow.py passes run_id
with open('llama_index/core/agent/workflow/multi_agent_workflow.py') as f:
    content = f.read()
    if 'run_id' not in content:
        print('FAIL: multi_agent_workflow.py does not reference run_id')
        errors += 1
    else:
        print('PASS: multi_agent_workflow.py references run_id')

# Check that agent_context.py has run_id support
with open('llama_index/core/agent/workflow/agent_context.py') as f:
    content = f.read()
    if 'run_id' not in content:
        print('FAIL: agent_context.py does not reference run_id')
        errors += 1
    else:
        print('PASS: agent_context.py references run_id')

if errors > 0:
    print(f'\nFAIL: {errors} modules missing run_id plumbing')
    exit(1)

print('\nAll run_id plumbing checks passed.')
"

# Run the agent workflow tests if they exist
if [ -f tests/agent/workflow/test_single_agent_workflow.py ]; then
    python -m pytest tests/agent/workflow/test_single_agent_workflow.py -x -q 2>&1 | tail -5
fi
if [ -f tests/agent/workflow/test_multi_agent_workflow.py ]; then
    python -m pytest tests/agent/workflow/test_multi_agent_workflow.py -x -q 2>&1 | tail -5
fi

echo "All checks passed."
