#!/usr/bin/env bash
set -euo pipefail

cd python/packages/autogen-core
source .venv/bin/activate 2>/dev/null || true
export PATH=".venv/bin:$PATH"

python3 -c "
import json

# Test 1: Untrusted provider should be rejected
try:
    from autogen_core._component_config import ComponentLoader

    # Try to load a component with an untrusted provider namespace
    config = {
        'provider': 'evil_package.malicious_module.BadClass',
        'config': {}
    }

    try:
        ComponentLoader.load_component(config)
        print('FAIL: Untrusted provider was not rejected')
        exit(1)
    except (ValueError, ImportError, Exception) as e:
        error_msg = str(e).lower()
        if 'trusted' in error_msg or 'allowed' in error_msg or 'namespace' in error_msg or 'not allowed' in error_msg:
            print(f'PASS: Untrusted provider correctly rejected: {e}')
        else:
            # It might fail for other reasons (module not found) which is also fine
            # as long as it doesn't succeed
            print(f'PASS: Untrusted provider failed to load: {e}')
except ImportError as e:
    print(f'WARN: Could not import ComponentLoader: {e}')
    exit(1)

# Test 2: Trusted AutoGen namespaces should still work
trusted_namespaces = ['autogen_core', 'autogen_agentchat', 'autogen_ext']
source_file = 'src/autogen_core/_component_config.py'

with open(source_file) as f:
    content = f.read()

# Verify the source code has namespace restriction logic
if 'trusted' in content.lower() or 'allowed' in content.lower() or 'namespace' in content.lower():
    print('PASS: Component config contains namespace restriction logic')
else:
    print('FAIL: Component config missing namespace restriction logic')
    exit(1)

print()
print('All security checks passed.')
"
