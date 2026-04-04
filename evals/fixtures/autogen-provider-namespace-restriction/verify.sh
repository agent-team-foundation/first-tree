#!/usr/bin/env bash
set -euo pipefail

cd python/packages/autogen-core
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

python3 -c "
from autogen_core._component_config import ComponentLoader

# Untrusted provider must be rejected with a namespace-specific error,
# not just a generic ImportError from the module not existing.
config = {
    'provider': 'evil_package.malicious_module.BadClass',
    'config': {}
}

try:
    ComponentLoader.load_component(config)
    print('FAIL: Untrusted provider was not rejected')
    exit(1)
except (ValueError, ImportError) as e:
    error_msg = str(e).lower()
    # Must mention namespace restriction — a generic 'No module named' is not sufficient
    if any(kw in error_msg for kw in ['trusted', 'allowed', 'namespace', 'not in', 'restrict']):
        print(f'PASS: Untrusted provider rejected with namespace error: {e}')
    elif 'no module named' in error_msg:
        print(f'FAIL: Got generic ImportError instead of namespace restriction: {e}')
        exit(1)
    else:
        print(f'FAIL: Unexpected error (no namespace keywords): {e}')
        exit(1)

print('All security checks passed.')
"
